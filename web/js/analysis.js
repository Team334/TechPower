/*
 * TechPower analysis: parses one match's .wpilog files and builds the dashboard payload.
 * Runs in the browser (js/worker.js) and in Node (tools/build-examples.mjs), so it touches
 * no DOM or filesystem. All times in the payload are seconds from the start of the main log.
 */

const THIN = 2;  // timeline payload is kept at resample_hz / THIN to stay small

// ─── WPILog parsing ───────────────────────────────────────────────────────────
// Format spec: https://github.com/wpilibsuite/allwpilib/blob/main/wpiutil/doc/datalog.md
// Only entries accepted by `wanted(name)` have their records decoded; everything else is
// skipped by header, which keeps large hoot logs fast to load.

// Numeric scalar types: type → [byte width, reader]
const NUMERIC = {
  double:  [8, (dv, o) => dv.getFloat64(o, true)],
  float:   [4, (dv, o) => dv.getFloat32(o, true)],
  int64:   [8, (dv, o) => Number(dv.getBigInt64(o, true))],
  integer: [8, (dv, o) => Number(dv.getBigInt64(o, true))],
  boolean: [1, (dv, o) => dv.getUint8(o)],
};

// WPILib structs made only of doubles, decoded to rows of this many values
// (Pose2d = x, y, heading rad; ChassisSpeeds = vx, vy, omega). "[]" variants decode to a list of row blocks.
const STRUCT_DOUBLES = {
  'struct:Rotation2d':    1,
  'struct:Translation2d': 2,
  'struct:Pose2d':        3,
  'struct:ChassisSpeeds': 3,
};

const LFS_POINTER_PREFIX = 'version https://git-lfs';
const utf8 = new TextDecoder();

// Little-endian unsigned int of 1–8 bytes (exact below 2^53, which covers µs timestamps).
function uint(b, p, len) {
  let v = 0;
  for (let k = len - 1; k >= 0; k--) v = v * 256 + b[p + k];
  return v;
}

/**
 * Returns Map(entry name → entry) for wanted entries. An entry is
 * { name, type, times: Float64Array (s), values, width } where values is a Float64Array of
 * `width` numbers per sample, or for struct arrays (list: true) one Float64Array per sample.
 */
export function parseWpilog(bytes, wanted, label = 'Log') {
  if (utf8.decode(bytes.subarray(0, LFS_POINTER_PREFIX.length)) === LFS_POINTER_PREFIX) {
    throw new Error(`${label} is a Git LFS pointer, not a log. Run \`git lfs pull\`.`);
  }
  if (bytes.length < 12 || utf8.decode(bytes.subarray(0, 6)) !== 'WPILOG') {
    throw new Error(`${label} is not a valid WPILog file.`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length;
  const entries = new Map();  // name → raw record lists, for wanted entries
  const byId = new Map();     // entry id → the same lists

  let pos = 12 + dv.getUint32(8, true);
  while (pos < n) {
    const b = bytes[pos];
    const il = (b & 3) + 1, pl = ((b >> 2) & 3) + 1, tl = ((b >> 4) & 7) + 1;
    const hdrEnd = pos + 1 + il + pl + tl;
    if (hdrEnd > n) break;  // truncated header at end of file
    const id = uint(bytes, pos + 1, il);
    const size = uint(bytes, pos + 1 + il, pl);
    const end = hdrEnd + size;
    if (end > n) break;     // truncated payload (log cut off mid-write)

    if (id !== 0) {
      const raw = byId.get(id);
      if (raw) {
        raw.ts.push(uint(bytes, pos + 1 + il + pl, tl));
        raw.offs.push(hdrEnd);
        raw.sizes.push(size);
      }
    } else if (size && bytes[hdrEnd] === 0) {  // start record
      const start = parseStart(bytes, dv, hdrEnd + 1, end);
      if (start && wanted(start.name)) {
        let raw = entries.get(start.name);
        if (!raw) entries.set(start.name, raw = { name: start.name, type: start.type, ts: [], offs: [], sizes: [] });
        byId.set(start.id, raw);
      } else if (start) {
        byId.delete(start.id);
      }
    }
    pos = end;
  }

  const out = new Map();
  for (const [name, raw] of entries) out.set(name, decode(raw, dv));
  return out;
}

function parseStart(bytes, dv, p, end) {
  const str = () => {
    if (p + 4 > end) return null;
    const len = dv.getUint32(p, true);
    if (p + 4 + len > end) return null;
    const s = utf8.decode(bytes.subarray(p + 4, p + 4 + len));
    p += 4 + len;
    return s;
  };
  if (p + 4 > end) return null;
  const id = dv.getUint32(p, true);
  p += 4;
  const name = str(), type = str();
  return name == null || type == null ? null : { id, name, type };
}

function decode({ name, type, ts, offs, sizes }, dv) {
  const num = NUMERIC[type], k = STRUCT_DOUBLES[type];
  if (num || k) {
    const width = num ? 1 : k, bytesNeeded = num ? num[0] : 8 * k;
    const keep = [];
    for (let i = 0; i < ts.length; i++) if (sizes[i] >= bytesNeeded) keep.push(i);
    const times = new Float64Array(keep.length), values = new Float64Array(keep.length * width);
    keep.forEach((i, j) => {
      times[j] = ts[i] / 1e6;
      if (num) values[j] = num[1](dv, offs[i]);
      else for (let c = 0; c < k; c++) values[j * k + c] = dv.getFloat64(offs[i] + 8 * c, true);
    });
    return { name, type, times, values, width };
  }

  const ka = type.endsWith('[]') ? STRUCT_DOUBLES[type.slice(0, -2)] : undefined;
  if (ka) {
    const values = offs.map((o, i) => {
      const rows = Math.floor(sizes[i] / (8 * ka)), a = new Float64Array(rows * ka);
      for (let c = 0; c < a.length; c++) a[c] = dv.getFloat64(o + 8 * c, true);
      return a;
    });
    return { name, type, times: Float64Array.from(ts, t => t / 1e6), values, width: ka, list: true };
  }

  // Other types (strings, plain arrays) aren't used by the analysis.
  return { name, type, times: new Float64Array(0), values: new Float64Array(0), width: 1 };
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

/**
 * logs = { main: {name, bytes}, swerve?: {name, bytes}, subsystems?: {name, bytes} }, bytes a Uint8Array.
 * Returns the payload the dashboard renders. Throws Error with a user-facing message for bad logs.
 */
export function analyzeMatch(logs, config, matchName = 'Match') {
  const keys = config.log_sources.wpilog.keys;
  const sigKeys = config.log_sources.hoot.signal_keys;  // friendly name → TalonFX signal suffix
  const hz = config.timeline.resample_hz;
  const whDiv = config.energy_calculation.wh_conversion;
  const sagV = config.thresholds.sag_voltage;          // time spent below this is reported as sag
  const breakerA = config.thresholds.breaker_amps;     // per-motor PDH breaker rating
  const subsystems = Object.fromEntries(config.subsystems.map(s => [s.id, s]));

  const leafWanted = (exact, suffixes) => name => exact.has(name) || suffixes.some(s => name.endsWith(s));
  const mainWanted = leafWanted(new Set(Object.values(keys)), Object.values(keys).map(k => '/' + leaf(k)));
  const hootWanted = leafWanted(new Set(['RobotEnable']), Object.values(sigKeys).map(s => '/' + s));

  const parsed = {};
  for (const [role, log] of Object.entries(logs)) {
    parsed[role] = parseWpilog(log.bytes, role === 'main' ? mainWanted : hootWanted, log.name);
  }
  const main = parsed.main;
  const warnings = [];

  const volt = find(main, keys.battery_voltage);
  if (!volt) throw new Error(`Main log has no battery voltage (${keys.battery_voltage}). Is this the FRC_*.wpilog?`);
  const curr = find(main, keys.battery_current);
  if (!curr) warnings.push(`No battery current (${keys.battery_current}) in main log; energy totals unavailable.`);
  const enabled = find(main, keys.enabled);
  const auto = find(main, keys.autonomous);

  const t0 = volt.times[0], t1 = volt.times[volt.times.length - 1];
  const dt = 1 / hz;
  const grid = arange(0, t1 - t0 + dt / 2, dt);
  const tAbs = grid.map(t => t + t0);
  const n = grid.length;

  const battV = zoh(volt, tAbs);
  const battI = zoh(curr, tAbs);
  const segments = matchSegments(enabled, auto, t0, t1);

  const timeline = {
    time:            list(grid),
    battery_voltage: list(battV),
    battery_current: list(battI),
  };

  // ── Robot pose (blue-origin field coordinates) and speed ──
  const poseEntry = 'pose' in keys ? find(main, keys.pose) : null;
  let pose = poseEntry && poseEntry.width >= 3 ? zoh(poseEntry, tAbs) : null;
  if (pose && pose.some(Number.isFinite)) {
    timeline.pose_x = list(pose, 3, 0);
    timeline.pose_y = list(pose, 3, 1);
    timeline.pose_heading = list(pose, 3, 2);
  } else {
    pose = null;
  }
  const speedEntry = 'chassis_speeds' in keys ? find(main, keys.chassis_speeds) : null;
  if (speedEntry && speedEntry.width >= 2) {
    const s = zoh(speedEntry, tAbs), w = speedEntry.width;
    const speed = new Float64Array(n).map((_, i) => Math.hypot(s[i * w], s[i * w + 1]));
    if (speed.some(Number.isFinite)) timeline.speed = list(speed);
  }

  // ── Motors (hoot logs run on the CANivore clock; shift onto the main clock) ──
  const offsets = {}, shifted = {};
  for (const bus of ['swerve', 'subsystems']) {
    if (!parsed[bus]) continue;
    offsets[bus] = hootOffset(parsed[bus], enabled, warnings, bus);
    shifted[bus] = tAbs.map(t => t - offsets[bus]);
  }
  const series = Object.fromEntries(Object.keys(sigKeys).map(sig => [sig, {}]));
  const motors = config.motors.map(motor => {
    const entries = parsed[motor.hoot_bus], offset = offsets[motor.hoot_bus] ?? 0;
    const sigs = {}, resampled = {};
    if (entries?.size && motor.talon_id != null) {
      for (const sig of Object.keys(sigKeys)) {
        const e = findHoot(entries, motor.talon_id, sigKeys[sig]);
        if (e) {
          sigs[sig] = e;
          series[sig][motor.id] = resampled[sig] = zoh(e, shifted[motor.hoot_bus]);
        }
      }
    }
    return motorStats(motor, subsystems, sigs, resampled, battV, t0 - offset, t1 - offset, hz, whDiv, breakerA);
  });

  for (const [sig, outKey] of [['stator_current', 'stator_current_by_motor'],
                               ['supply_current', 'supply_current_by_motor'],
                               ['motor_voltage',  'motor_voltage_by_motor'],
                               ['temperature',    'temp_by_motor']]) {
    const bySig = series[sig];
    if (bySig && Object.keys(bySig).length) {
      timeline[outKey] = Object.fromEntries(Object.entries(bySig).map(([id, s]) => [id, list(s)]));
    }
  }

  const missing = ['swerve', 'subsystems'].filter(r => !parsed[r]);
  if (missing.length) warnings.push(`No ${missing.join(' / ')} hoot log; motor data for that bus is unavailable.`);

  // ── Energy ──
  const power = battV.map((v, i) => v * battI[i]);
  const energyBySegment = [];
  segments.forEach((seg, idx) => {
    const [lo, hi] = span(grid, seg.start, seg.end);
    if (hi - lo >= 2) {
      energyBySegment.push({
        label: `${seg.type[0].toUpperCase()}${seg.type.slice(1)} ${idx + 1}`, type: seg.type,
        start: seg.start, end: seg.end, wh: r(integrateHours(power.subarray(lo, hi), dt, whDiv)),
      });
    }
  });

  const energyBySubsystem = {};
  for (const m of motors) {
    if (m.energy_wh != null) energyBySubsystem[m.subsystem_id] = (energyBySubsystem[m.subsystem_id] ?? 0) + m.energy_wh;
  }

  const brownoutEvents = brownouts(find(main, keys.brownout), t0, t1, grid, battV, battI, series.supply_current);
  if (pose) {
    for (const ev of brownoutEvents) {
      const i = Math.min(Math.round(ev.time / dt), n - 1);
      ev.x = r(pose[i * 3]);
      ev.y = r(pose[i * 3 + 1]);
    }
  }

  let sagSamples = 0;
  for (const v of battV) if (v < sagV) sagSamples++;

  return {
    match_name:          matchName,
    duration:            r(t1 - t0),
    t_start:             r(t0),
    timeline,
    match_segments:      segments,
    brownout_events:     brownoutEvents,
    brownout_count:      brownoutEvents.length,
    peak_voltage:        r(nanMax(battV)),
    min_voltage:         r(nanMin(battV)),
    peak_current:        curr ? r(nanMax(battI)) : null,
    avg_current:         curr ? r(nanMean(battI)) : null,
    total_energy_wh:     curr ? r(integrateHours(power, dt, whDiv)) : null,
    charge_ah:           curr ? r(integrateHours(battI, dt, whDiv)) : null,
    sag_seconds:         r(sagSamples * dt, 1),
    battery:             batteryFit(volt, curr),
    thresholds:          { sag_voltage: sagV, breaker_amps: breakerA },
    energy_by_segment:   energyBySegment,
    trajectories:        'auto_trajectory' in keys ? trajectories(find(main, keys.auto_trajectory), t0, t1) : [],
    energy_by_subsystem: Object.fromEntries(Object.entries(energyBySubsystem).map(([k, v]) => [k, r(v)])),
    subsystems:          config.subsystems,
    motors,
    warnings,
  };
}

// Peaks/averages from raw samples inside the match window; energy from the resampled grid.
function motorStats(motor, subsystems, sigs, resampled, battV, lo, hi, hz, whDiv, breakerA) {
  const subsys = subsystems[motor.subsystem_id] ?? {};
  const raw = sig => {
    const e = sigs[sig];
    if (!e) return null;
    const v = e.values.filter((_, i) => e.times[i] >= lo && e.times[i] <= hi);
    return v.length ? v : null;
  };
  const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
  const abs = v => v.map(Math.abs);
  const stator = raw('stator_current'), supply = raw('supply_current'), temp = raw('temperature');

  // Net energy drawn from the battery: signed supply current (negative = regen) × supply voltage.
  // Seconds above the breaker rating: sustained time there is what trips a PDH breaker.
  let energyWh = null, overBreaker = null;
  const sup = resampled.supply_current;
  if (sup) {
    const volts = resampled.supply_voltage ?? battV;
    const p = sup.map((a, i) => (Number.isNaN(volts[i]) ? battV[i] : volts[i]) * a);
    energyWh = r(integrateHours(p, 1 / hz, whDiv));
    let over = 0;
    for (const a of sup) if (Math.abs(a) > breakerA) over++;
    overBreaker = r(over / hz, 1);
  }

  return {
    id:                  motor.id,
    name:                motor.name,
    subsystem_id:        motor.subsystem_id ?? null,
    subsystem:           subsys.name ?? motor.subsystem_id ?? '',
    color:               subsys.color ?? '#888888',
    channel:             motor.channel ?? null,
    has_data:            Object.keys(sigs).length > 0,
    peak_stator_current: stator ? r(nanMax(abs(stator))) : null,
    peak_supply_current: supply ? r(nanMax(abs(supply))) : null,
    avg_supply_current:  supply ? r(mean(abs(supply))) : null,
    rms_supply_current:  supply ? r(Math.sqrt(mean(supply.map(a => a * a)))) : null,
    over_breaker_s:      overBreaker,
    max_temp:            temp ? r(nanMax(temp)) : null,
    avg_temp:            temp ? r(mean(temp)) : null,
    energy_wh:           energyWh,
  };
}

// ─── Log lookup ───────────────────────────────────────────────────────────────

const leaf = key => key.slice(key.lastIndexOf('/') + 1);

// Exact key, else any non-empty entry whose last path segment matches.
function find(entries, key) {
  const e = entries.get(key);
  if (e?.times.length) return e;
  const suffix = '/' + leaf(key);
  for (const [name, x] of entries) if (name.endsWith(suffix) && x.times.length) return x;
  return null;
}

// Phoenix 6 hoot keys look like Phoenix6/TalonFX-<id>/<Signal>.
function findHoot(entries, talonId, signal) {
  const tail = `TalonFX-${talonId}/${signal}`;
  for (const name of [`Phoenix6/${tail}`, `/Phoenix6/${tail}`]) {
    if (entries.get(name)?.times.length) return entries.get(name);
  }
  for (const [name, e] of entries) if (name.endsWith('/' + tail) && e.times.length) return e;
  return null;
}

// ─── Time alignment & segments ────────────────────────────────────────────────

// Seconds to add to hoot timestamps to land on the main log's clock: matches the first
// robot-enable rising edge seen by the CANivore with the first DS:enabled rising edge.
function hootOffset(entries, enabled, warnings, bus) {
  const mainEdges = onSpans(enabled), hootEdges = onSpans(entries.get('RobotEnable'));
  if (mainEdges.length && hootEdges.length) return mainEdges[0][0] - hootEdges[0][0];
  warnings.push(`Couldn't sync the ${bus} hoot log to the main log (robot never enabled); motor timing may be off.`);
  return 0;
}

// [start, end] of each stretch where a boolean signal is true; an open stretch ends at tEnd.
function onSpans(entry, tEnd = Infinity) {
  if (!entry?.times.length) return [];
  const spans = [];
  let on = false, start = 0;
  entry.values.forEach((v, i) => {
    if ((v !== 0) === on) return;
    on = !on;
    if (on) start = entry.times[i];
    else spans.push([start, entry.times[i]]);
  });
  if (on) spans.push([start, tEnd]);
  return spans;
}

// Each brownout with its depth, the robot's draw, and the motors pulling hardest around it.
function brownouts(entry, t0, t1, grid, battV, battI, supplyByMotor) {
  const events = [];
  for (const [start, end] of onSpans(entry, t1)) {
    if (!(t0 <= start && start <= t1)) continue;
    const t = start - t0;
    const [lo, hi] = span(grid, t - 0.5, t + 0.5);
    const top = Object.entries(supplyByMotor)
      .map(([id, s]) => [id, nanMax(s.subarray(lo, hi).map(Math.abs))])
      .filter(([, a]) => !Number.isNaN(a))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    events.push({
      time:         r(t, 3),
      duration:     r(end - start, 3),
      min_voltage:  r(nanMin(battV.subarray(lo, hi))),
      peak_current: r(nanMax(battI.subarray(lo, hi))),
      top_motors:   top.map(([id, a]) => ({ id, amps: r(a, 1) })),
    });
  }
  return events;
}

// Planned auto paths: when each was published (relative s) and its x/y points, thinned for drawing.
function trajectories(entry, t0, t1, maxPoints = 120) {
  if (!entry?.list) return [];
  const k = entry.width, out = [];
  entry.values.forEach((pts, i) => {
    const t = entry.times[i], rows = pts.length / k;
    if (!(t0 <= t && t <= t1) || !rows) return;
    const step = Math.max(1, Math.floor(rows / maxPoints)), points = [];
    for (let j = 0; j < rows; j += step) points.push([r(pts[j * k]), r(pts[j * k + 1])]);
    points.push([r(pts[(rows - 1) * k]), r(pts[(rows - 1) * k + 1])]);
    out.push({ time: r(t - t0), points });
  });
  return out;
}

// Battery model V = V_rest − R·I fitted over loaded samples. R includes the robot's main wiring
// and breaker, so it's for comparing batteries match to match. PDH current arrives late over
// CAN, so first find the lag that best explains the sag.
function batteryFit(volt, curr) {
  if (!volt || !curr) return null;
  const t = arange(volt.times[0], volt.times[volt.times.length - 1], 0.01);
  const v = zoh(volt, t);
  let best = null;
  for (let step = 0; step <= 25; step++) {
    const lag = step * 0.01;
    const i = zoh(curr, t.map(x => x + lag));
    const xs = [], ys = [];
    i.forEach((a, k) => { if (!Number.isNaN(v[k]) && a > 5) { xs.push(a); ys.push(v[k]); } });
    if (xs.length < 500 || nanMax(xs) - nanMin(xs) < 40) continue;  // not enough load swing to separate R from noise
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxx = 0, syy = 0, sxy = 0;
    xs.forEach((x, k) => { sxx += (x - mx) ** 2; syy += (ys[k] - my) ** 2; sxy += (x - mx) * (ys[k] - my); });
    const slope = sxy / sxx, r2 = sxy * sxy / (sxx * syy);
    if (!best || r2 > best.r2) best = { r2, resistance: -slope, vRest: my - slope * mx, lag };
  }
  if (!best || !(best.r2 >= 0.5) || best.resistance <= 0) return null;
  return {
    resistance_mohm: r(best.resistance * 1000, 1), resting_voltage: r(best.vRest, 2),
    fit_r2: r(best.r2, 2), current_lag_ms: Math.round(best.lag * 1000),
  };
}

// Disabled/auto/teleop spans (relative seconds) covering the whole log.
function matchSegments(enabled, auto, t0, t1) {
  if (!enabled) return [];
  const ts = Float64Array.from(new Set([...enabled.times, ...(auto ? auto.times : [])])).sort();
  const isEn = zoh(enabled, ts, true), isAu = zoh(auto, ts, true);
  const segments = [];
  const visit = (t, mode) => {
    t = Math.min(Math.max(t, t0), t1) - t0;
    const last = segments[segments.length - 1];
    if (last?.type === mode) return;
    if (last) last.end = r(t, 3);
    segments.push({ start: r(t, 3), end: null, type: mode });
  };
  visit(t0, 'disabled');
  ts.forEach((t, i) => visit(t, !(isEn[i] > 0) ? 'disabled' : isAu[i] > 0 ? 'auto' : 'teleop'));
  segments[segments.length - 1].end = r(t1 - t0, 3);
  return segments.filter(s => s.end > s.start);
}

// ─── Numeric helpers ──────────────────────────────────────────────────────────

function arange(start, stop, step) {
  const n = Math.max(0, Math.ceil((stop - start) / step));
  return Float64Array.from({ length: n }, (_, i) => start + i * step);
}

// Zero-order-hold resample onto ascending times t. NaN where the signal has no data.
// Struct entries keep `width` values per sample.
function zoh(entry, t, holdAfter = false) {
  const w = entry?.width ?? 1;
  const out = new Float64Array(t.length * w).fill(NaN);
  if (!entry?.times.length) return out;
  const { times, values } = entry, last = times[times.length - 1];
  let j = -1;
  for (let i = 0; i < t.length; i++) {
    while (j + 1 < times.length && times[j + 1] <= t[i]) j++;
    if (j < 0 || (!holdAfter && t[i] > last)) continue;
    for (let c = 0; c < w; c++) out[i * w + c] = values[j * w + c];
  }
  return out;
}

// [lo, hi) index range of ascending a with lo ≤ value ≤ hi.
function span(a, from, to) {
  const bound = (x, strict) => {
    let lo = 0, hi = a.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (strict ? a[mid] <= x : a[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  return [bound(from, false), bound(to, true)];
}

// Trapezoidal ∫x dt on a uniform grid, in hours (W → Wh, A → Ah). Gaps (NaN) count as zero.
function integrateHours(x, dt, whDiv) {
  let sum = 0;
  for (let i = 1; i < x.length; i++) sum += (x[i] || 0) + (x[i - 1] || 0);
  return sum * 0.5 * dt / whDiv;
}

function nanMax(a) {
  let m = NaN;
  for (const v of a) if (v > m || (Number.isNaN(m) && !Number.isNaN(v))) m = v;
  return m;
}

function nanMin(a) {
  let m = NaN;
  for (const v of a) if (v < m || (Number.isNaN(m) && !Number.isNaN(v))) m = v;
  return m;
}

function nanMean(a) {
  let sum = 0, count = 0;
  for (const v of a) if (!Number.isNaN(v)) { sum += v; count++; }
  return count ? sum / count : NaN;
}

// Every THIN-th sample of column c, rounded; NaN → null so charts show gaps.
function list(a, width = 1, c = 0) {
  const out = [];
  for (let i = 0; i * width < a.length; i += THIN) out.push(r(a[i * width + c]));
  return out;
}

// Round to `digits`; null for missing or non-finite values.
function r(v, digits = 3) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
