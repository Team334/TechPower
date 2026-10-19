"""
TechPower — Flask backend
Run:  flask run   or   python app.py
"""

import hashlib
import json
import logging
import os
import re
import shutil
import tempfile
import threading
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor
from functools import partial
from pathlib import Path

import numpy as np
from flask import Flask, Response, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from wpilog_parser import parse_wpilog

BASE_DIR = Path(__file__).resolve().parent

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 1 GB — a full match (main + 2 hoot) is ~300 MB
log = logging.getLogger("techpower")

# ── Load config ────────────────────────────────────────────────────────────────
CONFIG = json.loads((BASE_DIR / "config.json").read_text(encoding="utf-8"))

SUBSYSTEMS  = {s["id"]: s for s in CONFIG["subsystems"]}
RESAMPLE_HZ = CONFIG["timeline"]["resample_hz"]
WH_DIV      = CONFIG["energy_calculation"]["wh_conversion"]
SAG_V       = CONFIG["thresholds"]["sag_voltage"]     # time spent below this is reported as sag
BREAKER_A   = CONFIG["thresholds"]["breaker_amps"]    # per-motor PDH breaker rating
MAIN_KEYS   = CONFIG["log_sources"]["wpilog"]["keys"]
PREFIX_MAP  = CONFIG["log_sources"]["hoot"]["prefix_map"]   # {"01": "subsystems", "CC": "swerve"}
SIG_KEYS    = CONFIG["log_sources"]["hoot"]["signal_keys"]  # friendly-name → TalonFX suffix
EXAMPLES    = {s["id"]: s for s in CONFIG.get("example_logs", {}).get("sessions", [])}

THIN = 2  # timeline payload is sent at RESAMPLE_HZ / THIN to keep the JSON small
ROLES = ("main", "swerve", "subsystems")


class AnalysisError(ValueError):
    """A problem with the user's logs — reported back as a 400 with this message."""


# ── Filename classifier ────────────────────────────────────────────────────────
# Matches filenames like:
#   FRC_20260407_183251_NYN2_Q17.wpilog                    → main
#   NYN2_Q17_CC478FD…_2026-04-07_18-32-51.hoot.wpilog     → swerve
#   NYN2_Q17_01CED6F…_2026-04-07_18-32-51.hoot.wpilog     → subsystems
_HOOT_RE = re.compile(r"^(.*?)_([0-9A-F]{2})[0-9A-F]{30}_\d{4}-\d{2}-\d{2}_", re.IGNORECASE)
_MAIN_RE = re.compile(r"FRC_\d{8}_\d{6}_(.+)")


def classify_filename(name: str) -> str:
    """Return 'main', 'swerve', 'subsystems', or 'unknown' based on filename."""
    m = _HOOT_RE.search(name)
    if not m:
        return "main"
    return PREFIX_MAP.get(m.group(2).upper(), "unknown")


def _match_token(name: str) -> str | None:
    """'NYN2_Q17' from either a main or hoot filename, for sanity-checking uploads."""
    base = os.path.basename(name).split(".")[0]
    m = _HOOT_RE.search(os.path.basename(name)) or _MAIN_RE.match(base)
    return m.group(1).upper() if m else None


def _infer_match_name(filename: str) -> str:
    """Extract e.g. 'NYN2 Q17' from FRC_20260407_183251_NYN2_Q17.wpilog"""
    base = os.path.splitext(os.path.basename(filename))[0]
    m = _MAIN_RE.match(base)
    return m.group(1).replace("_", " ") if m else base


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", example_sessions=list(EXAMPLES.values()),
                           version=CONFIG["app"]["version"], prefix_map=PREFIX_MAP)


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """Accept 1–3 uploaded log files (one match), parse them, return JSON analysis."""
    files = [f for f in request.files.getlist("logs") if f.filename]
    if not files:
        raise AnalysisError("No files uploaded.")

    by_role: dict[str, str] = {}
    warnings = []
    for f in files:
        if not f.filename.lower().endswith(".wpilog"):
            raise AnalysisError(f"{f.filename} is not a .wpilog file. Convert .hoot logs to .wpilog first.")
        role = classify_filename(f.filename)
        if role == "unknown":
            warnings.append(f"Ignored {f.filename}: unrecognized CANivore prefix.")
            continue
        if role in by_role:
            raise AnalysisError(f"Two {role} logs uploaded ({by_role[role]}, {f.filename}). Upload one match at a time.")
        by_role[role] = f.filename

    if "main" not in by_role:
        raise AnalysisError("Main robot log (FRC_*.wpilog) is required.")
    tokens = {_match_token(n) for n in by_role.values()} - {None}
    if len(tokens) > 1:
        warnings.append(f"Files look like they're from different matches ({', '.join(sorted(tokens))}).")

    tmp_dir = tempfile.mkdtemp(prefix="techpower-")
    try:
        paths, key = {}, []
        for f in files:
            role = classify_filename(f.filename)
            if by_role.get(role) != f.filename:
                continue
            paths[role] = os.path.join(tmp_dir, f"{role}.wpilog")
            key.append((role, _save_and_hash(f.stream, paths[role])))
        payload = _cached_analysis(tuple(sorted(key)), paths, _infer_match_name(by_role["main"]), warnings)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return Response(payload, mimetype="application/json")


@app.route("/api/example/<session_id>")
def example(session_id: str):
    """Load a bundled example session by ID."""
    sess = EXAMPLES.get(session_id)
    if sess is None:
        return jsonify({"error": "Unknown example session."}), 404

    paths = {
        "main":       BASE_DIR / sess["wpilog"],
        "swerve":     BASE_DIR / sess["hoot_swerve"],
        "subsystems": BASE_DIR / sess["hoot_subsystems"],
    }
    paths = {role: str(p) for role, p in paths.items() if p.is_file()}
    if "main" not in paths:
        raise AnalysisError(f"Example log for {sess['name']} is missing.")
    key = tuple(sorted((role, os.stat(p).st_size, os.stat(p).st_mtime_ns) for role, p in paths.items()))
    payload = _cached_analysis(key, paths, sess["name"], [])
    return Response(payload, mimetype="application/json")


@app.errorhandler(Exception)
def handle_error(err):
    if not request.path.startswith("/api/"):
        return err if isinstance(err, HTTPException) else ("Internal Server Error", 500)
    if isinstance(err, HTTPException):
        msg = "Upload too large (max 1 GB)." if err.code == 413 else err.description
        return jsonify({"error": msg}), err.code
    if isinstance(err, ValueError):  # AnalysisError and parser format errors
        return jsonify({"error": str(err)}), 400
    log.exception("Analysis failed")
    return jsonify({"error": f"Analysis failed: {type(err).__name__}: {err}"}), 500


def _save_and_hash(stream, dest: str) -> str:
    h = hashlib.sha256()
    with open(dest, "wb") as out:
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
            out.write(chunk)
    return h.hexdigest()


# ── Result cache ───────────────────────────────────────────────────────────────
# Parsing a match takes seconds; reopening one should be instant.

_CACHE_SIZE = 8
_cache: "OrderedDict[tuple, str]" = OrderedDict()
_cache_lock = threading.Lock()


def _cached_analysis(key: tuple, paths: dict, match_name: str, warnings: list) -> str:
    key = (key, match_name, tuple(warnings))
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    result = run_analysis(paths, match_name)
    result["warnings"] = warnings + result["warnings"]
    payload = json.dumps(result, separators=(",", ":"))
    with _cache_lock:
        _cache[key] = payload
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return payload


# ── Parsing (one process per file, in parallel) ────────────────────────────────

def _leaf(key: str) -> str:
    return key.rsplit("/", 1)[-1]


def _wants(exact: frozenset, suffixes: tuple, name: str) -> bool:
    return name in exact or name.endswith(suffixes)


_MAIN_WANTED = partial(_wants, frozenset(MAIN_KEYS.values()),
                       tuple("/" + _leaf(k) for k in MAIN_KEYS.values()))
_HOOT_WANTED = partial(_wants, frozenset({"RobotEnable"}),
                       tuple("/" + s for s in SIG_KEYS.values()))

_pool = None
_pool_lock = threading.Lock()


def _parse_all(paths: dict) -> dict:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ProcessPoolExecutor(max_workers=len(ROLES))
    futures = {role: _pool.submit(parse_wpilog, path, _MAIN_WANTED if role == "main" else _HOOT_WANTED)
               for role, path in paths.items()}
    return {role: fut.result() for role, fut in futures.items()}


def _find(entries: dict, key: str):
    """Exact key, else any non-empty entry whose last path segment matches."""
    e = entries.get(key)
    if e is not None and len(e):
        return e
    suffix = "/" + _leaf(key)
    return next((e for name, e in entries.items() if name.endswith(suffix) and len(e)), None)


def _find_hoot(entries: dict, talon_id: int, signal: str):
    """Phoenix 6 hoot keys look like Phoenix6/TalonFX-<id>/<Signal>."""
    tail = f"TalonFX-{talon_id}/{SIG_KEYS[signal]}"
    for name in (f"Phoenix6/{tail}", f"/Phoenix6/{tail}"):
        if name in entries and len(entries[name]):
            return entries[name]
    return next((e for name, e in entries.items() if name.endswith("/" + tail) and len(e)), None)


# ── Core analysis ──────────────────────────────────────────────────────────────

def run_analysis(paths: dict, match_name: str = "Match") -> dict:
    """
    paths = {"main": filepath, "swerve": filepath, "subsystems": filepath}
    Returns the full JSON payload consumed by the frontend. All times in the
    payload are seconds relative to the start of the main log.
    """
    parsed = _parse_all(paths)
    main = parsed["main"]
    warnings = []

    volt = _find(main, MAIN_KEYS["battery_voltage"])
    if volt is None:
        raise AnalysisError(f"Main log has no battery voltage ({MAIN_KEYS['battery_voltage']}). Is this the FRC_*.wpilog?")
    curr = _find(main, MAIN_KEYS["battery_current"])
    if curr is None:
        warnings.append(f"No battery current ({MAIN_KEYS['battery_current']}) in main log; energy totals unavailable.")
    enabled = _find(main, MAIN_KEYS["enabled"])
    auto    = _find(main, MAIN_KEYS["autonomous"])

    t0, t1 = float(volt.times[0]), float(volt.times[-1])
    dt = 1.0 / RESAMPLE_HZ
    grid = np.arange(0.0, t1 - t0 + dt / 2, dt)
    t_abs = grid + t0

    batt_v = _zoh(volt, t_abs)
    batt_i = _zoh(curr, t_abs)
    segments = _segments(enabled, auto, t0, t1)

    timeline = {
        "time":            _list(grid[::THIN]),
        "battery_voltage": _list(batt_v[::THIN]),
        "battery_current": _list(batt_i[::THIN]),
    }

    # ── Motors (hoot logs run on the CANivore clock; shift onto the main clock) ──
    offsets = {bus: _hoot_offset(parsed[bus], enabled, warnings, bus)
               for bus in ("swerve", "subsystems") if bus in parsed}
    series = {sig: {} for sig in SIG_KEYS}
    motor_stats = []
    for motor in CONFIG["motors"]:
        entries = parsed.get(motor.get("hoot_bus"))
        offset = offsets.get(motor.get("hoot_bus"), 0.0)
        sigs = {}
        if entries and motor.get("talon_id") is not None:
            for sig in SIG_KEYS:
                e = _find_hoot(entries, motor["talon_id"], sig)
                if e is not None:
                    sigs[sig] = e
                    series[sig][motor["id"]] = _zoh(e, t_abs - offset)
        motor_stats.append(_motor_stats(motor, sigs, {s: v[motor["id"]] for s, v in series.items() if motor["id"] in v},
                                        batt_v, t0 - offset, t1 - offset))

    for sig, out_key in (("stator_current", "stator_current_by_motor"),
                         ("supply_current", "supply_current_by_motor"),
                         ("motor_voltage",  "motor_voltage_by_motor"),
                         ("temperature",    "temp_by_motor")):
        if series.get(sig):
            timeline[out_key] = {mid: _list(s[::THIN]) for mid, s in series[sig].items()}

    missing = [r for r in ("swerve", "subsystems") if r not in parsed]
    if missing:
        warnings.append(f"No {' / '.join(missing)} hoot log; motor data for that bus is unavailable.")

    # ── Energy ────────────────────────────────────────────────────────────────
    power = batt_v * batt_i
    energy_by_segment = []
    for idx, seg in enumerate(segments):
        mask = (grid >= seg["start"]) & (grid <= seg["end"])
        if mask.sum() >= 2:
            energy_by_segment.append({"label": f"{seg['type'].capitalize()} {idx + 1}", "type": seg["type"],
                                      "start": seg["start"], "end": seg["end"],
                                      "wh": _r(_integrate_hours(power[mask], dt))})

    energy_by_subsystem = {}
    for m in motor_stats:
        if m["energy_wh"] is not None:
            sid = m["subsystem_id"]
            energy_by_subsystem[sid] = energy_by_subsystem.get(sid, 0.0) + m["energy_wh"]

    brownout_events = _brownouts(_find(main, MAIN_KEYS["brownout"]), t0, t1, grid, batt_v, batt_i,
                                 series["supply_current"])

    return {
        "match_name":          match_name,
        "duration":            _r(t1 - t0),
        "t_start":             _r(t0),
        "timeline":            timeline,
        "match_segments":      segments,
        "brownout_events":     brownout_events,
        "brownout_count":      len(brownout_events),
        "peak_voltage":        _r(np.nanmax(batt_v)),
        "min_voltage":         _r(np.nanmin(batt_v)),
        "peak_current":        _r(np.nanmax(batt_i)) if curr is not None else None,
        "avg_current":         _r(np.nanmean(batt_i)) if curr is not None else None,
        "total_energy_wh":     _r(_integrate_hours(power, dt)) if curr is not None else None,
        "charge_ah":           _r(_integrate_hours(batt_i, dt)) if curr is not None else None,
        "sag_seconds":         _r(float(np.sum(batt_v < SAG_V)) * dt, 1),
        "battery":             _battery_fit(volt, curr),
        "thresholds":          {"sag_voltage": SAG_V, "breaker_amps": BREAKER_A},
        "energy_by_segment":   energy_by_segment,
        "energy_by_subsystem": {k: _r(v) for k, v in energy_by_subsystem.items()},
        "subsystems":          CONFIG["subsystems"],
        "motors":              motor_stats,
        "warnings":            warnings,
    }


def _motor_stats(motor: dict, sigs: dict, resampled: dict, batt_v: np.ndarray, lo: float, hi: float) -> dict:
    """Peaks/averages from raw samples inside the match window; energy from the resampled grid."""
    subsys = SUBSYSTEMS.get(motor.get("subsystem_id"), {})

    def raw(sig):
        e = sigs.get(sig)
        if e is None:
            return None
        v = e.values[(e.times >= lo) & (e.times <= hi)]
        return v if len(v) else None

    def peak(v):
        return _r(np.max(np.abs(v))) if v is not None else None

    def mean(v):
        return _r(np.mean(np.abs(v))) if v is not None else None

    stator, supply, temp = raw("stator_current"), raw("supply_current"), raw("temperature")

    # Net energy drawn from the battery: signed supply current (negative = regen) × supply voltage.
    energy_wh = None
    if "supply_current" in resampled:
        volts = resampled.get("supply_voltage", batt_v)
        volts = np.where(np.isnan(volts), batt_v, volts)
        energy_wh = _r(_integrate_hours(volts * resampled["supply_current"], 1.0 / RESAMPLE_HZ))

    # Seconds above the breaker rating — sustained time here is what trips a PDH breaker.
    over_breaker = None
    if "supply_current" in resampled:
        over_breaker = _r(float(np.sum(np.abs(resampled["supply_current"]) > BREAKER_A)) / RESAMPLE_HZ, 1)

    return {
        "id":                  motor["id"],
        "name":                motor["name"],
        "subsystem_id":        motor.get("subsystem_id"),
        "subsystem":           subsys.get("name", motor.get("subsystem_id", "")),
        "color":               subsys.get("color", "#888888"),
        "channel":             motor.get("channel"),
        "has_data":            bool(sigs),
        "peak_stator_current": peak(stator),
        "peak_supply_current": peak(supply),
        "avg_supply_current":  mean(supply),
        "rms_supply_current":  _r(np.sqrt(np.mean(np.square(supply)))) if supply is not None else None,
        "over_breaker_s":      over_breaker,
        "max_temp":            _r(np.max(temp)) if temp is not None else None,
        "avg_temp":            _r(np.mean(temp)) if temp is not None else None,
        "energy_wh":           energy_wh,
    }


# ── Time alignment & segments ──────────────────────────────────────────────────

def _hoot_offset(entries: dict, enabled, warnings: list, bus: str) -> float:
    """
    Seconds to add to hoot timestamps to land on the main log's clock.
    Matches the first robot-enable rising edge seen by the CANivore with the
    first DS:enabled rising edge in the main log.
    """
    main_edges = _rising_edges(enabled)
    hoot_edges = _rising_edges(entries.get("RobotEnable"))
    if main_edges and hoot_edges:
        return main_edges[0] - hoot_edges[0]
    warnings.append(f"Couldn't sync the {bus} hoot log to the main log (robot never enabled); motor timing may be off.")
    return 0.0


def _on_spans(entry, t_end: float = np.inf) -> list:
    """(start, end) of each stretch where a boolean signal is true; an open stretch ends at t_end."""
    if entry is None or not len(entry):
        return []
    on = np.asarray(entry.values, dtype=bool)
    flips = np.flatnonzero(np.diff(np.concatenate(([False], on))))
    starts, ends = entry.times[flips[::2]], entry.times[flips[1::2]]
    return [(float(s), float(ends[k]) if k < len(ends) else t_end) for k, s in enumerate(starts)]


def _rising_edges(entry) -> list:
    return [s for s, _ in _on_spans(entry)]


def _brownouts(entry, t0: float, t1: float, grid, batt_v, batt_i, supply_by_motor: dict) -> list:
    """Each brownout with its depth, the robot's draw, and the motors pulling hardest around it."""
    events = []
    for start, end in _on_spans(entry, t1):
        if not t0 <= start <= t1:
            continue
        t = start - t0
        near = (grid >= t - 0.5) & (grid <= t + 0.5)
        top = sorted(((mid, float(np.nanmax(np.abs(s[near])))) for mid, s in supply_by_motor.items()
                      if np.any(~np.isnan(s[near]))), key=lambda x: -x[1])[:3]
        events.append({
            "time":         _r(t, 3),
            "duration":     _r(end - start, 3),
            "min_voltage":  _r(np.nanmin(batt_v[near])) if np.any(~np.isnan(batt_v[near])) else None,
            "peak_current": _r(np.nanmax(batt_i[near])) if np.any(~np.isnan(batt_i[near])) else None,
            "top_motors":   [{"id": mid, "amps": _r(a, 1)} for mid, a in top],
        })
    return events


def _battery_fit(volt, curr) -> dict | None:
    """
    Battery model V = V_rest − R·I fitted over loaded samples. R includes the robot's
    main wiring and breaker, so it's for comparing batteries match to match.
    PDH current arrives late over CAN, so first find the lag that best explains the sag.
    """
    if volt is None or curr is None:
        return None
    t = np.arange(volt.times[0], volt.times[-1], 0.01)
    v = _zoh(volt, t)
    best = None
    for lag in np.arange(0.0, 0.26, 0.01):
        i = _zoh(curr, t + lag)
        ok = ~np.isnan(v) & ~np.isnan(i) & (i > 5)
        if ok.sum() < 500 or np.ptp(i[ok]) < 40:
            continue  # not enough load swing to separate R from noise
        slope, intercept = np.polyfit(i[ok], v[ok], 1)
        r2 = np.corrcoef(i[ok], v[ok])[0, 1] ** 2
        if best is None or r2 > best[0]:
            best = (r2, -slope, intercept, lag)
    if best is None or best[0] < 0.5 or best[1] <= 0:
        return None
    r2, resistance, v_rest, lag = best
    return {"resistance_mohm": _r(resistance * 1000, 1), "resting_voltage": _r(v_rest, 2),
            "fit_r2": _r(r2, 2), "current_lag_ms": round(lag * 1000)}


def _segments(enabled, auto, t0: float, t1: float) -> list:
    """Disabled/auto/teleop spans (relative seconds) covering the whole log."""
    if enabled is None:
        return []
    ts = np.union1d(enabled.times, auto.times if auto is not None else [])
    is_en = np.nan_to_num(_zoh(enabled, ts, hold_after=True)) > 0
    is_au = np.nan_to_num(_zoh(auto, ts, hold_after=True)) > 0
    modes = np.where(~is_en, "disabled", np.where(is_au, "auto", "teleop"))

    segments = []
    for t, mode in zip(np.concatenate(([t0], ts)), np.concatenate((["disabled"], modes))):
        t = min(max(float(t), t0), t1) - t0
        if segments and segments[-1]["type"] == mode:
            continue
        if segments:
            segments[-1]["end"] = round(t, 3)
        segments.append({"start": round(t, 3), "end": None, "type": str(mode)})
    segments[-1]["end"] = round(t1 - t0, 3)
    return [s for s in segments if s["end"] > s["start"]]


# ── Numeric helpers ────────────────────────────────────────────────────────────

def _zoh(entry, t: np.ndarray, hold_after: bool = False) -> np.ndarray:
    """Zero-order-hold resample onto t. NaN where the signal has no data."""
    out = np.full(len(t), np.nan)
    if entry is None or not len(entry):
        return out
    idx = np.searchsorted(entry.times, t, side="right") - 1
    inside = idx >= 0
    if not hold_after:
        inside &= t <= entry.times[-1]
    out[inside] = np.asarray(entry.values, dtype=np.float64)[idx[inside]]
    return out


def _integrate_hours(x: np.ndarray, dt: float) -> float:
    """Trapezoidal ∫x dt on a uniform grid, in hours (W → Wh, A → Ah). Gaps (NaN) count as zero."""
    p = np.nan_to_num(x)
    if len(p) < 2:
        return 0.0
    return float((p[1:] + p[:-1]).sum() * 0.5 * dt) / WH_DIV


def _list(a: np.ndarray) -> list:
    """Rounded JSON-safe list; NaN → null so charts show gaps."""
    a = np.round(a, 3)
    return [None if v != v else v for v in a.tolist()]


def _r(v, digits: int = 3):
    """Round a value, return None if None/NaN/inf."""
    if v is None:
        return None
    v = float(v)
    return round(v, digits) if np.isfinite(v) else None


# ── Dev server ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(debug=True, port=5000)
