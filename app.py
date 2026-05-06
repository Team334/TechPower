"""
TechPower — Flask backend
Run: flask run  or  python app.py
"""
import json, os, math, struct
from flask import Flask, render_template, request, jsonify, send_from_directory
from wpilog_parser import parse_wpilog, extract_battery_data, build_match_segments

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024  # 64 MB upload limit

# ── load config ────────────────────────────────────────────────────────────────
with open("config.json") as f:
    CONFIG = json.load(f)

MOTORS     = {m["id"]: m for m in CONFIG["motors"]}
SUBSYSTEMS = {s["id"]: s for s in CONFIG["subsystems"]}
RESAMPLE_HZ = CONFIG["timeline"]["resample_hz"]
WH_DIV      = CONFIG["energy_calculation"]["wh_conversion"]

# ── helpers ────────────────────────────────────────────────────────────────────

def interp_at(records, t, keys=None):
    """Linear-interpolate a (timestamp, value) list at time t."""
    if not records:
        return 0.0
    if t <= records[0][0]:
        return float(records[0][1])
    if t >= records[-1][0]:
        return float(records[-1][1])
    
    import bisect
    # Use binary search to find the correct interval
    if keys is None:
        keys = [r[0] for r in records]
    i = bisect.bisect_right(keys, t) - 1
    if i < 0:
        i = 0
    if i >= len(records) - 1:
        i = len(records) - 2
        
    t0, v0 = records[i]
    t1, v1 = records[i + 1]
    if t0 <= t <= t1:
        alpha = (t - t0) / (t1 - t0) if t1 != t0 else 0
        return float(v0) + alpha * float(v1 - v0)
    return 0.0


def resample(records, t_start, t_end, hz=RESAMPLE_HZ):
    """Return evenly-spaced (t, v) list."""
    if not records or t_end <= t_start:
        return []
    dt = 1.0 / hz
    out = []
    t = t_start
    keys = [r[0] for r in records]
    while t <= t_end + 1e-9:
        out.append((round(t, 4), interp_at(records, t, keys)))
        t += dt
    return out


def channel_power_records(channel_current_records, voltage_records):
    """Multiply per-channel current × battery voltage → power records."""
    if not channel_current_records or not voltage_records:
        return []
    out = []
    keys = [r[0] for r in voltage_records]
    for t, amps in channel_current_records:
        v = interp_at(voltage_records, t, keys)
        out.append((t, amps * v))
    return out


def energy_wh(power_records):
    """Trapezoidal integration → Wh."""
    total = 0.0
    for i in range(1, len(power_records)):
        t0, p0 = power_records[i - 1]
        t1, p1 = power_records[i]
        total += (p0 + p1) / 2 * (t1 - t0)
    return total / WH_DIV


def compute_motor_stats(motor_cfg, entries, battery_voltage):
    """Return dict of stats for one motor given its PDP channel."""
    ch  = motor_cfg["channel"]
    key = CONFIG["log_sources"]["wpilog"]["keys"]["pdp_channel_current"]

    # PDP channel current is stored as an array per timestamp
    ch_records = []
    if key in entries:
        for t, arr in entries[key].records:
            if isinstance(arr, list) and ch < len(arr):
                ch_records.append((t, arr[ch]))

    if not ch_records:
        return None

    power_recs = channel_power_records(ch_records, battery_voltage)
    if not power_recs:
        return None

    powers = [p for _, p in power_recs]
    energy = energy_wh(power_recs)
    avg_p  = sum(powers) / len(powers)
    peak_p = max(powers)
    avg_a  = sum(a for _, a in ch_records) / len(ch_records)

    # stator current — try Talon/Kraken logging path
    stator_key = f"/Robot/Motors/{motor_cfg['id']}/StatorCurrent"
    stator_recs = entries.get(stator_key, None)
    avg_stator = max_stator = 0.0
    if stator_recs and stator_recs.records:
        vals = [v for _, v in stator_recs.records]
        avg_stator = sum(vals) / len(vals)
        max_stator = max(vals)

    return {
        "id":         motor_cfg["id"],
        "name":       motor_cfg["name"],
        "subsystem":  motor_cfg["subsystem_id"],
        "channel":    ch,
        "energy_wh":  round(energy, 3),
        "avg_power":  round(avg_p, 2),
        "peak_power": round(peak_p, 2),
        "avg_supply": round(avg_a, 3),
        "avg_stator": round(avg_stator, 3),
        "max_stator": round(max_stator, 3),
    }


def build_timeline(entries, battery, t_start, t_end):
    """
    Build a resampled timeline dict:
      timestamps, total_power, per-subsystem power arrays
    """
    hz = RESAMPLE_HZ
    dt = 1.0 / hz
    times = []
    t = t_start
    while t <= t_end + 1e-9:
        times.append(round(t, 4))
        t += dt

    # total battery power = V × I
    voltage = battery["voltage"]
    current = battery["current"]
    total_power = []
    v_keys = [r[0] for r in voltage] if voltage else []
    i_keys = [r[0] for r in current] if current else []
    for t in times:
        v = interp_at(voltage, t, v_keys)
        i = interp_at(current, t, i_keys)
        total_power.append(round(v * i, 2))

    # per-subsystem: sum motor channel powers
    key = CONFIG["log_sources"]["wpilog"]["keys"]["pdp_channel_current"]
    pdp_entry = entries.get(key)

    subsys_power = {sid: [0.0] * len(times) for sid in SUBSYSTEMS}

    if pdp_entry:
        ch_arrays = pdp_entry.records  # [(t, [ch0..chN]), ...]
        for motor in CONFIG["motors"]:
            ch  = motor["channel"]
            sid = motor["subsystem_id"]
            ch_records = []
            for t_r, arr in ch_arrays:
                if isinstance(arr, list) and ch < len(arr):
                    ch_records.append((t_r, arr[ch]))
            c_keys = [r[0] for r in ch_records] if ch_records else []
            for idx, t in enumerate(times):
                amps = interp_at(ch_records, t, c_keys)
                v    = interp_at(voltage, t, v_keys)
                subsys_power[sid][idx] = round(subsys_power[sid][idx] + amps * v, 2)

    return {
        "timestamps":    times,
        "total_power":   total_power,
        "subsys_power":  subsys_power,
    }


def process_log(filepath):
    entries = parse_wpilog(filepath)
    battery = extract_battery_data(entries, CONFIG)
    segments = build_match_segments(battery)

    all_times = [t for t, _ in battery["voltage"]] + [t for t, _ in battery["current"]]
    if not all_times:
        return {"error": "No battery data found in log."}

    t_start = min(all_times)
    t_end   = max(all_times)
    duration = t_end - t_start

    # motor stats
    motor_stats = []
    for m in CONFIG["motors"]:
        s = compute_motor_stats(m, entries, battery["voltage"])
        if s:
            motor_stats.append(s)

    # subsystem rollups
    subsys_stats = {}
    for sid, sub in SUBSYSTEMS.items():
        motors_in = [s for s in motor_stats if s["subsystem"] == sid]
        subsys_stats[sid] = {
            "id":       sid,
            "name":     sub["name"],
            "color":    sub["color"],
            "energy_wh":  round(sum(m["energy_wh"]  for m in motors_in), 3),
            "avg_power":  round(sum(m["avg_power"]   for m in motors_in), 2),
            "peak_power": round(max((m["peak_power"] for m in motors_in), default=0), 2),
            "motors":   motors_in,
        }

    total_energy = round(sum(s["energy_wh"] for s in subsys_stats.values()), 3)
    peak_power   = round(max(
        (v for vals in build_timeline(entries, battery, t_start, t_end)["subsys_power"].values()
         for v in vals), default=0), 2)
    brownouts    = len(battery["brownout_times"])

    timeline = build_timeline(entries, battery, t_start, t_end)

    return {
        "duration":       round(duration, 2),
        "t_start":        round(t_start, 4),
        "t_end":          round(t_end, 4),
        "total_energy":   total_energy,
        "peak_power":     peak_power,
        "brownouts":      brownouts,
        "brownout_times": battery["brownout_times"],
        "subsystems":     list(subsys_stats.values()),
        "motors":         motor_stats,
        "segments":       segments,
        "timeline":       timeline,
    }


# ── routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", config=CONFIG)


@app.route("/api/upload", methods=["POST"])
def upload():
    files = request.files.getlist("logs")
    if not files:
        return jsonify({"error": "No files uploaded"}), 400

    results = []
    import tempfile
    for f in files:
        with tempfile.NamedTemporaryFile(suffix=".wpilog", delete=False) as tmp:
            f.save(tmp.name)
            try:
                data = process_log(tmp.name)
                data["filename"] = f.filename
                results.append(data)
            except Exception as e:
                results.append({"filename": f.filename, "error": str(e)})
            finally:
                os.unlink(tmp.name)

    if len(results) == 1:
        return jsonify(results[0])
    return jsonify({"merged": results})


@app.route("/api/session/<session_id>")
def load_session(session_id):
    sessions = {s["id"]: s for s in CONFIG["example_logs"]["sessions"]}
    if session_id not in sessions:
        return jsonify({"error": "Unknown session"}), 404
    sess = sessions[session_id]
    path = os.path.join(os.path.dirname(__file__), sess["wpilog"])
    if not os.path.exists(path):
        return jsonify({"error": f"Log file not found: {sess['wpilog']}"}), 404
    try:
        data = process_log(path)
        data["filename"] = sess["name"]
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory("static", path)


@app.route("/api/debug/<session_id>")
def debug_session(session_id):
    """Returns raw parse info — open this in your browser to diagnose loading issues."""
    sessions = {s["id"]: s for s in CONFIG["example_logs"]["sessions"]}
    if session_id not in sessions:
        return jsonify({"error": "Unknown session"}), 404
    sess = sessions[session_id]
    path = os.path.join(os.path.dirname(__file__), sess["wpilog"])

    if not os.path.exists(path):
        return jsonify({"error": f"File not found", "looked_at": path})

    try:
        entries = parse_wpilog(path)
        key_sample = list(entries.keys())[:60]

        # Check for each config key
        wpilog_keys = CONFIG["log_sources"]["wpilog"]["keys"]
        key_check = {}
        for field, k in wpilog_keys.items():
            entry = entries.get(k)
            key_check[field] = {
                "key": k,
                "found": entry is not None,
                "type": entry.type_str if entry else None,
                "record_count": len(entry.records) if entry else 0,
                "sample": str(entry.records[0]) if entry and entry.records else None,
            }

        # PDP channel array shape
        pdp_key = wpilog_keys["pdp_channel_current"]
        pdp_entry = entries.get(pdp_key)
        pdp_info = None
        if pdp_entry and pdp_entry.records:
            t0, v0 = pdp_entry.records[0]
            pdp_info = {
                "record_count": len(pdp_entry.records),
                "type_str": pdp_entry.type_str,
                "first_value_type": type(v0).__name__,
                "first_value_len": len(v0) if isinstance(v0, list) else "scalar",
                "first_value_sample": v0[:5] if isinstance(v0, list) else v0,
            }

        return jsonify({
            "file": path,
            "total_entries": len(entries),
            "key_check": key_check,
            "pdp_info": pdp_info,
            "all_keys_sample": key_sample,
        })
    except Exception as e:
        import traceback
        return jsonify({"error": str(e), "traceback": traceback.format_exc()})


if __name__ == "__main__":
    app.run(debug=True, port=5000)