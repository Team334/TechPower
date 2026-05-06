"""
TechPower — Flask backend
Run:  flask run   or   python app.py
"""

import bisect
import json
import math
import os
import re
import tempfile

from flask import Flask, jsonify, render_template, request, send_from_directory

from wpilog_parser import (
    WPILogEntry,
    build_match_segments,
    extract_battery_data,
    parse_wpilog,
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024  # 256 MB

# ── Load config ────────────────────────────────────────────────────────────────
with open("config.json") as f:
    CONFIG = json.load(f)

MOTORS      = {m["id"]: m for m in CONFIG["motors"]}
SUBSYSTEMS  = {s["id"]: s for s in CONFIG["subsystems"]}
RESAMPLE_HZ = CONFIG["timeline"]["resample_hz"]
WH_DIV      = CONFIG["energy_calculation"]["wh_conversion"]
PREFIX_MAP  = CONFIG["log_sources"]["hoot"]["prefix_map"]   # {"01": "subsystems", "CC": "swerve"}
SIG_KEYS    = CONFIG["log_sources"]["hoot"]["signal_keys"]  # friendly-name → TalonFX suffix

# ── Filename classifier ────────────────────────────────────────────────────────
# Matches filenames like:
#   FRC_20260407_183251_NYN2_Q17.wpilog                    → main
#   NYN2_Q17_CC478FD…_2026-04-07_18-32-51.hoot.wpilog     → swerve
#   NYN2_Q17_01CED6F…_2026-04-07_18-32-51.hoot.wpilog     → subsystems
_HOOT_RE = re.compile(r"_([0-9A-Fa-f]{2})[0-9A-Fa-f]{30}_\d{4}-\d{2}-\d{2}_", re.IGNORECASE)


def classify_filename(name: str) -> str:
    """Return 'main', 'swerve', or 'subsystems' based on filename."""
    m = _HOOT_RE.search(name)
    if not m:
        return "main"
    prefix = m.group(1).upper()
    return PREFIX_MAP.get(prefix, "unknown")


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    sessions = CONFIG.get("example_logs", {}).get("sessions", [])
    return render_template("index.html", example_sessions=sessions)


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """Accept 1–3 uploaded log files, parse them, return JSON analysis."""
    files = request.files.getlist("logs")
    if not files:
        return jsonify({"error": "No files uploaded"}), 400

    # Save to temp files and classify
    saved = {}  # role → filepath
    tmp_paths = []

    for f in files:
        role = classify_filename(f.filename)
        suffix = ".wpilog"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            f.save(tmp.name)
            tmp_paths.append(tmp.name)
            saved[role] = tmp.name

    try:
        result = run_analysis(saved, match_name=_infer_match_name(files[0].filename))
    finally:
        for p in tmp_paths:
            try:
                os.unlink(p)
            except OSError:
                pass

    return jsonify(result)


@app.route("/api/example/<session_id>")
def example(session_id: str):
    """Load a bundled example session by ID."""
    sessions = {s["id"]: s for s in CONFIG.get("example_logs", {}).get("sessions", [])}
    if session_id not in sessions:
        return jsonify({"error": "Unknown session"}), 404

    sess = sessions[session_id]
    saved = {
        "main":       sess["wpilog"],
        "swerve":     sess["hoot_swerve"],
        "subsystems": sess["hoot_subsystems"],
    }
    result = run_analysis(saved, match_name=sess["name"])
    return jsonify(result)


# ── Core analysis ──────────────────────────────────────────────────────────────

def run_analysis(paths: dict, match_name: str = "Match") -> dict:
    """
    paths = {"main": filepath, "swerve": filepath, "subsystems": filepath}
    Returns the full JSON payload consumed by the frontend.
    """
    main_entries   = parse_wpilog(paths["main"])        if "main"        in paths else {}
    swerve_entries = parse_wpilog(paths["swerve"])      if "swerve"      in paths else {}
    subsys_entries = parse_wpilog(paths["subsystems"])  if "subsystems"  in paths else {}

    battery      = extract_battery_data(main_entries, CONFIG)
    segments_raw = build_match_segments(battery)

    segments = []
    for seg in segments_raw:
        t = seg.get("mode") or seg.get("type", "disabled")
        if t == "auton":
            t = "auto"
        segments.append({"start": seg["start"], "end": seg["end"], "type": t})

    v_records = battery["voltage"]
    i_records = battery["current"]
    t_start   = v_records[0][0]  if v_records else 0.0
    t_end     = v_records[-1][0] if v_records else 0.0
    if not t_end:
        t_end = i_records[-1][0] if i_records else 0.0
    duration = t_end - t_start

    timeline_full = _resample_timeline(battery, t_start, t_end)
    times_full    = timeline_full["time"]

    # Thin to 25 Hz for payload
    THIN = 2
    times_thin = timeline_full["time"][::THIN]
    timeline = {
        "time":            times_thin,
        "battery_voltage": timeline_full["battery_voltage"][::THIN],
        "battery_current": timeline_full["battery_current"][::THIN],
    }

    # ── Per-motor hoot timeseries ─────────────────────────────────────────────
    hoot_map = {"swerve": swerve_entries, "subsystems": subsys_entries}

    stator_by_motor  = {}   # motor_id → list[float]  (thinned)
    supply_by_motor  = {}
    stator_v_by_motor = {}
    temp_by_motor    = {}

    for motor in CONFIG["motors"]:
        mid      = motor["id"]
        bus_name = motor.get("hoot_bus")
        talon_id = motor.get("talon_id")
        if bus_name is None or talon_id is None or bus_name not in hoot_map:
            continue
        entries = hoot_map[bus_name]
        if not entries:
            continue

        def _thin_signal(sig_name):
            e = _find_hoot_entry(entries, bus_name, talon_id, sig_name)
            if not e:
                return None
            records = [(t - t_start, v) for t, v in e.records if t >= t_start]
            full = _resample_records(records, times_full)
            return [_r(v) for v in full[::THIN]]

        sc = _thin_signal("stator_current")
        if sc:
            stator_by_motor[mid] = sc

        sup = _thin_signal("supply_current")
        if sup:
            supply_by_motor[mid] = sup

        sv = _thin_signal("stator_voltage")
        if sv:
            stator_v_by_motor[mid] = sv

        tmp = _thin_signal("temperature")
        if tmp:
            temp_by_motor[mid] = tmp

    # Attach motor timeseries to timeline
    if stator_by_motor:
        timeline["stator_current_by_motor"]  = stator_by_motor
    if supply_by_motor:
        timeline["supply_current_by_motor"]  = supply_by_motor
    if stator_v_by_motor:
        timeline["stator_voltage_by_motor"]  = stator_v_by_motor
    if temp_by_motor:
        timeline["temp_by_motor"]            = temp_by_motor

    # ── Brownouts ─────────────────────────────────────────────────────────────
    brownout_events = [
        {"time": round(t - t_start, 4)}
        for t in battery["brownout_times"]
        if t_start <= t <= t_end
    ]

    # ── Summary stats ─────────────────────────────────────────────────────────
    volts = timeline_full["battery_voltage"]
    amps  = timeline_full["battery_current"]

    peak_voltage = max(volts) if volts else None
    min_voltage  = min(volts) if volts else None
    peak_current = max(amps)  if amps  else None
    avg_current  = _mean(amps)

    total_energy_wh = _integrate_power(times_full, volts, amps) / WH_DIV

    energy_by_segment = _energy_per_segment(timeline_full, segments)

    # ── Motor stats ────────────────────────────────────────────────────────────
    motor_stats = _build_motor_stats(hoot_map)

    # ── Energy by subsystem ────────────────────────────────────────────────────
    # Use the SAME per-motor supply timeseries we already computed so the
    # numbers are consistent with what the charts display.
    energy_by_subsystem = _energy_by_subsystem_from_timeseries(
        supply_by_motor, timeline_full, t_start, times_thin
    )

    return {
        "match_name":    match_name,
        "duration":      round(duration, 3),
        "t_start":       round(t_start, 3),
        "timeline":      timeline,
        "match_segments":    segments,
        "brownout_events":   brownout_events,
        "brownout_count":    len(brownout_events),
        "peak_voltage":      _r(peak_voltage),
        "min_voltage":       _r(min_voltage),
        "peak_current":      _r(peak_current),
        "avg_current":       _r(avg_current),
        "total_energy_wh":   _r(total_energy_wh),
        "energy_by_segment": energy_by_segment,
        "energy_by_subsystem": energy_by_subsystem,
        "motors":            motor_stats,
    }


def _energy_by_subsystem_from_timeseries(
    supply_by_motor: dict,
    timeline_full: dict,
    t_start: float,
    times_thin: list,
) -> dict:
    """
    Compute per-subsystem Wh from the pre-resampled per-motor supply-current
    timeseries (same data the charts use) so the numbers are always consistent.

    supply_by_motor : {motor_id: [float, …]}  — already thinned (25 Hz)
    timeline_full   : full 50 Hz timeline (for battery voltage)
    times_thin      : the 25 Hz time axis matching supply_by_motor arrays
    """
    # We need voltage at the same 25 Hz grid.
    # timeline_full is 50 Hz; thin it 2× to align.
    volts_thin = timeline_full["battery_voltage"][::2]

    # Make sure lengths align (could differ by 1 due to int division)
    n = min(len(times_thin), len(volts_thin))
    times_thin = times_thin[:n]
    volts_thin = volts_thin[:n]

    # Map motor → subsystem bus
    motor_bus = {m["id"]: m.get("hoot_bus") for m in CONFIG["motors"]}

    # Accumulate per-bus total-current arrays
    bus_current: dict[str, list] = {}
    for mid, currents in supply_by_motor.items():
        bus = motor_bus.get(mid)
        if bus is None:
            continue
        cur = currents[:n]  # align length
        if bus not in bus_current:
            bus_current[bus] = [0.0] * n
        for i, v in enumerate(cur):
            bus_current[bus][i] += abs(v) if v is not None else 0.0

    result = {}
    for bus, cur in bus_current.items():
        wh = _integrate_power(times_thin, volts_thin, cur) / WH_DIV
        if wh > 0:
            result[bus] = _r(wh)

    return result 

# ── Resampling ─────────────────────────────────────────────────────────────────

def _resample_timeline(battery: dict, t_start: float, t_end: float) -> dict:
    """Resample voltage & current to a uniform RESAMPLE_HZ grid."""
    dt = 1.0 / RESAMPLE_HZ
    n  = max(2, int((t_end - t_start) * RESAMPLE_HZ) + 1)
    times = [round(i * dt, 4) for i in range(n)]    # relative to t_start

    v_abs = [(t, v) for t, v in battery["voltage"] if t_start <= t <= t_end]
    i_abs = [(t, v) for t, v in battery["current"] if t_start <= t <= t_end]

    def resample(records):
        if not records:
            return [0.0] * n
        out = []
        ri = 0
        for ti in times:
            t_abs = ti + t_start
            while ri + 1 < len(records) and records[ri + 1][0] <= t_abs:
                ri += 1
            out.append(_r(records[ri][1]))
        return out

    return {
        "time":            times,
        "battery_voltage": resample(v_abs),
        "battery_current": resample(i_abs),
    }


# ── Energy calculations ────────────────────────────────────────────────────────

def _integrate_power(times, volts, amps) -> float:
    """Trapezoidal integration of V*I over time → Joules."""
    if len(times) < 2:
        return 0.0
    total = 0.0
    for i in range(1, len(times)):
        dt = times[i] - times[i - 1]
        p  = 0.5 * (volts[i] * amps[i] + volts[i - 1] * amps[i - 1])
        total += p * dt
    return total


def _energy_per_segment(timeline: dict, segments: list) -> list:
    """Return Wh consumed in each match segment."""
    times = timeline["time"]
    volts = timeline["battery_voltage"]
    amps  = timeline["battery_current"]
    result = []

    for idx, seg in enumerate(segments):
        js = [j for j, t in enumerate(times) if seg["start"] <= t <= seg["end"]]
        if len(js) < 2:
            continue
        seg_v = [volts[j] for j in js]
        seg_i = [amps[j]  for j in js]
        seg_t = [times[j] for j in js]
        wh = _integrate_power(seg_t, seg_v, seg_i) / WH_DIV
        label = f"{seg['type'].capitalize()} {idx + 1}"
        result.append({"label": label, "type": seg["type"], "wh": _r(wh)})

    return result



def _resample_records(records: list, times: list) -> list:
    """
    Resample (t, v) records onto a uniform times grid using ZOH (hold last value).
    Uses bisect for O(n log m) instead of O(n*m).
    """
    if not records:
        return [0.0] * len(times)
    ts = [r[0] for r in records]
    vs = [r[1] for r in records]
    out = []
    for t in times:
        i = bisect.bisect_right(ts, t) - 1
        out.append(vs[i] if i >= 0 else vs[0])
    return out


# ── Hoot key lookup ────────────────────────────────────────────────────────────
# Keys in Phoenix 6 hoot files follow: /Phoenix6/TalonFX-<id>/<SignalSuffix>


def _find_hoot_entry(entries: dict, bus_name: str, talon_id: int, signal_name: str):
    """
    Search entries for a Phoenix 6 TalonFX signal.
    Hoot wpilog keys follow:  /Phoenix6/TalonFX-<id>/<SignalSuffix>
    e.g. /Phoenix6/TalonFX-1/StatorCurrent
    """
    suffix = SIG_KEYS.get(signal_name, signal_name)
    patterns = [
        f"/Phoenix6/TalonFX-{talon_id}/{suffix}",          # primary Phoenix 6 path
        f"Phoenix6/TalonFX-{talon_id}/{suffix}",
        f"/TalonFX/{talon_id}/{suffix}",                    # legacy fallbacks
        f"/{bus_name}/TalonFX/{talon_id}/{suffix}",
        f"/Subsystems/TalonFX/{talon_id}/{suffix}",
        f"/Swerve/TalonFX/{talon_id}/{suffix}",
    ]
    for p in patterns:
        if p in entries:
            return entries[p]
    # Fuzzy: any key containing TalonFX-<id>/<suffix>
    tail = f"TalonFX-{talon_id}/{suffix}"
    for key, entry in entries.items():
        if key.endswith(tail):
            return entry
    return None


# Patch _build_motor_stats to use _find_hoot_entry instead of direct dict lookup
def _build_motor_stats(hoot_map: dict) -> list:  # noqa: F811 (redefinition)
    stats = []

    for motor in CONFIG["motors"]:
        mid       = motor["id"]
        bus_name  = motor.get("hoot_bus")
        talon_id  = motor.get("talon_id")
        subsys_id = motor.get("subsystem_id", "")
        subsys    = SUBSYSTEMS.get(subsys_id, {})
        color     = subsys.get("color", "#888")

        entry_base = {
            "id":        mid,
            "name":      motor["name"],
            "subsystem": subsys.get("name", subsys_id),
            "color":     color,
            "channel":   motor.get("channel"),
        }

        if bus_name is None or talon_id is None or bus_name not in hoot_map:
            stats.append({**entry_base,
                "peak_stator_current": None, "peak_supply_current": None,
                "avg_supply_current":  None, "max_temp": None,
                "avg_temp": None, "energy_wh": None})
            continue

        entries = hoot_map[bus_name]
        if not entries:
            stats.append({**entry_base,
                "peak_stator_current": None, "peak_supply_current": None,
                "avg_supply_current":  None, "max_temp": None,
                "avg_temp": None, "energy_wh": None})
            continue

        def get_entry(sig):
            return _find_hoot_entry(entries, bus_name, talon_id, sig)

        def get_vals(sig):
            e = get_entry(sig)
            return [v for _, v in e.records] if e else []

        stator_vals = get_vals("stator_current")
        supply_vals = get_vals("supply_current")
        temp_vals   = get_vals("temperature")

        def safe_peak(vals):
            return _r(max(abs(v) for v in vals)) if vals else None

        def safe_mean(vals):
            return _r(_mean([abs(v) for v in vals])) if vals else None

        # Motor energy
        sv_entry = get_entry("supply_voltage")
        sc_entry = get_entry("supply_current")
        energy_wh = None
        if sv_entry and sc_entry:
            sv_times = [t for t, _ in sv_entry.records]
            sv_vals  = [v for _, v in sv_entry.records]
            sc_times = [t for t, _ in sc_entry.records]
            sc_vals  = [v for _, v in sc_entry.records]
            if sv_times and sc_times:
                sc_resampled = _resample_records(list(zip(sc_times, sc_vals)), sv_times)
                energy_wh = _r(
                    _integrate_power(sv_times, sv_vals, [abs(v) for v in sc_resampled]) / WH_DIV
                )

        stats.append({
            **entry_base,
            "peak_stator_current": safe_peak(stator_vals),
            "peak_supply_current": safe_peak(supply_vals),
            "avg_supply_current":  safe_mean(supply_vals),
            "max_temp":            safe_peak(temp_vals),
            "avg_temp":            safe_mean(temp_vals),
            "energy_wh":           energy_wh,
        })

    return stats


# ── Utility helpers ────────────────────────────────────────────────────────────

def _mean(vals: list) -> float:
    return sum(vals) / len(vals) if vals else 0.0


def _r(v, digits: int = 3):
    """Round a value, return None if None/NaN."""
    if v is None:
        return None
    try:
        if math.isnan(v) or math.isinf(v):
            return None
        return round(float(v), digits)
    except (TypeError, ValueError):
        return None


def _infer_match_name(filename: str) -> str:
    """Extract e.g. 'NYN2 Q17' from FRC_20260407_183251_NYN2_Q17.wpilog"""
    base = os.path.splitext(os.path.basename(filename))[0]
    # FRC_YYYYMMDD_HHMMSS_EVENT_MATCH
    m = re.match(r"FRC_\d{8}_\d{6}_(.+)", base)
    if m:
        return m.group(1).replace("_", " ")
    return base


# ── Dev server ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(debug=True, port=5000)