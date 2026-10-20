/* TechPower */
'use strict';

const MAX_COMPARE = 4;
const WARN_TEMP = 70, CRIT_TEMP = 90;
const MIN_ZOOM_S = 2;
const TRAIL_S = 5;             // seconds of path drawn behind the robot
const POSE_JUMP_M = 1;         // larger steps between samples are vision resets; don't connect them
const ROLES = ['main', 'swerve', 'subsystems'];
// FRC_20260407_183251_NYN2_Q17.wpilog → main; NYN2_Q17_CC478FD…_2026-04-07_18-32-51.hoot.wpilog → CANivore "CC"
const HOOT_RE = /^(.*?)_([0-9A-F]{2})[0-9A-F]{30}_\d{4}-\d{2}-\d{2}_/i;
const MAIN_RE = /^FRC_\d{8}_\d{6}_(.+)/;

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v)) ? '–' : v.toFixed(d);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  session: null,
  t: 0,
  playing: false,
  speed: 1,
  tab: 'timeline',
  zoom: { min: 0, max: 1 },
  zoomDirty: false,
  charts: {},                         // canvas id → Chart
  slots: new Array(MAX_COMPARE).fill(null),  // compared motor ids; index = color slot
  liveRows: [],
  liveIdx: -1,
  files: {},                          // role → File
  field: null,                        // field image calibration from config.json
  fieldScale: 1,
  busy: false,
  theme: null,
  config: null,                       // web/config.json
};

function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = n => s.getPropertyValue(n).trim();
  return {
    ink: v('--ink'), ink2: v('--ink-2'), ink3: v('--ink-3'), grid: v('--grid'),
    surface: v('--surface'), rule: v('--rule'), critical: v('--critical'),
    auto: v('--auto'), teleop: v('--teleop'), brand: v('--brand'),
    series: [1, 2, 3, 4].map(i => v(`--series-${i}`)),
  };
}

// Subsystems take fixed slots so a bus keeps its color everywhere it appears.
const SUBSYSTEM_SLOTS = [0, 2, 3, 1];
const subsystemColor = idx => `var(--series-${SUBSYSTEM_SLOTS[idx % 4] + 1})`;
const subsystemColorValue = idx => State.theme.series[SUBSYSTEM_SLOTS[idx % 4]];

// ─── Upload ───────────────────────────────────────────────────────────────────
function classify(name) {
  const m = HOOT_RE.exec(name);
  if (!m) return 'main';
  return State.config.log_sources.hoot.prefix_map[m[2].toUpperCase()] || 'unknown';
}

// 'NYN2_Q17' from either a main or hoot filename, for sanity-checking a set of files.
function matchToken(name) {
  const m = HOOT_RE.exec(name) || MAIN_RE.exec(name.split('.')[0]);
  return m ? m[1].toUpperCase() : null;
}

function addFiles(list) {
  const notes = [];
  for (const f of list) {
    if (!/\.wpilog$/i.test(f.name)) {
      notes.push(`${f.name} isn't a .wpilog file. Convert .hoot logs to .wpilog in Phoenix Tuner first.`);
      continue;
    }
    const role = classify(f.name);
    if (role === 'unknown') { notes.push(`${f.name} doesn't match a known CANivore.`); continue; }
    State.files[role] = f;
  }
  renderSlots();
  setStatus(notes, notes.length > 0);
  if (!notes.length && ROLES.every(r => State.files[r])) analyzeFiles();
}

function renderSlots() {
  document.querySelectorAll('.slot').forEach(li => {
    const f = State.files[li.dataset.role];
    li.classList.toggle('filled', !!f);
    li.querySelector('.slot-file').textContent = f ? f.name : '';
  });
  $('clear-btn').hidden = !Object.keys(State.files).length;
  setBusyUI(State.busy);
}

function clearFiles() {
  State.files = {};
  $('file-input').value = '';
  renderSlots();
  setStatus('');
}

function setStatus(msg, isError = false, busy = false) {
  const el = $('upload-status');
  const items = (Array.isArray(msg) ? msg : [msg]).filter(Boolean);
  el.classList.toggle('error', isError);
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.innerHTML = items.length > 1
    ? `<ul>${items.map(m => `<li>${esc(m)}</li>`).join('')}</ul>`
    : esc(items[0] || '');
  if (busy) el.insertAdjacentHTML('beforeend', '<div class="busy-bar"></div>');
}

function setBusyUI(busy) {
  const btn = $('analyze-btn');
  btn.disabled = busy || !State.files.main;
  btn.textContent = busy ? 'Analyzing…' : 'Analyze match';
  document.querySelectorAll('.example-btn').forEach(b => { b.disabled = busy; });
}

function analyzeFiles() {
  if (!State.files.main) { setStatus('Add the robot log (FRC_*.wpilog) first.', true); return; }
  const files = { ...State.files };
  const tokens = new Set(Object.values(files).map(f => matchToken(f.name)).filter(Boolean));
  const warnings = tokens.size > 1 ? [`Files look like they're from different matches (${[...tokens].sort().join(', ')}).`] : [];
  const base = files.main.name.replace(/\.[^.]*$/, '');
  const matchName = MAIN_RE.exec(base)?.[1].replaceAll('_', ' ') ?? base;
  history.replaceState(null, '', location.pathname);
  openSession(() => analyzeInWorker(files, matchName, warnings), 'Analyzing on this computer…');
}

function analyzeInWorker(files, matchName, warnings) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('js/worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error)); else resolve(data.result);
    };
    worker.onerror = e => {
      worker.terminate();
      reject(new Error(`Analysis failed: ${e.message || 'the analysis worker could not start'}.`));
    };
    worker.postMessage({ files, config: State.config, matchName, warnings });
  });
}

function loadExample(id) {
  const sess = (State.config.example_logs?.sessions || []).find(s => s.id === id);
  if (!sess) { setStatus(`There's no example match called "${id}".`, true); return; }
  if (new URLSearchParams(location.hash.slice(1)).get('example') !== id) {
    history.replaceState(null, '', `#example=${encodeURIComponent(id)}`);
  }
  openSession(async () => {
    const res = await fetch(`examples/${encodeURIComponent(id)}.json`);
    if (!res.ok) throw new Error(`Couldn't load the ${sess.name} example (${res.status}).`);
    return res.json();
  }, 'Opening example match…');
}

async function openSession(load, label) {
  if (State.busy) return;
  State.busy = true;
  setBusyUI(true);
  setStatus(label, false, true);
  try {
    const data = await load();
    setStatus('');
    showDashboard(data);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    State.busy = false;
    setBusyUI(false);
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function prepare(d) {
  const tl = d.timeline, n = tl.time.length;
  d.duration = Math.max(d.duration || 0, 0.001);
  d.dt = n > 1 ? tl.time[1] - tl.time[0] : 1;
  d.motorById = Object.fromEntries(d.motors.map(m => [m.id, m]));
  d.subsystemIndex = Object.fromEntries((d.subsystems || []).map((s, i) => [s.id, i]));
  d.hasMotorData = d.motors.some(m => m.has_data);

  // Summed supply current per bus (null where no motor on that bus has data)
  d.busTotals = {};
  const sup = tl.supply_current_by_motor || {};
  for (const m of d.motors) {
    const s = sup[m.id];
    if (!s) continue;
    const acc = d.busTotals[m.subsystem_id] ||= new Array(n).fill(null);
    for (let i = 0; i < n; i++) if (s[i] != null) acc[i] = (acc[i] ?? 0) + s[i];
  }
  return d;
}

function showDashboard(data) {
  teardownCharts();
  State.session = prepare(data);
  State.t = 0;
  State.zoom = { min: 0, max: data.duration };
  State.liveIdx = -1;
  State.slots = defaultSlots(data);

  $('upload-view').hidden = true;
  $('dashboard-view').hidden = false;
  document.title = `${data.match_name} – TechPower`;

  renderHeader(data);
  renderReadouts(data);
  renderScrubber(data);
  renderLiveTable(data);
  if ($('field-card')) $('field-card').hidden = !(State.field && data.timeline.pose_x);
  renderEnergy(data);
  renderTemperature(data);
  renderBrownouts(data);
  renderMotorTable(data);
  const tab = new URLSearchParams(location.hash.slice(1)).get('tab');
  switchTab(document.querySelector(`.tab[data-tab="${CSS.escape(tab || '')}"]`) ? tab : 'timeline');
  seek(0);
  window.scrollTo(0, 0);
}

// Busiest motor on each bus first, then fill by energy, so every bus is represented.
function defaultSlots(d) {
  const ranked = d.motors.filter(m => m.has_data)
    .sort((a, b) => (b.energy_wh ?? -Infinity) - (a.energy_wh ?? -Infinity));
  const picks = [];
  for (const m of ranked) if (!picks.some(p => p.subsystem_id === m.subsystem_id)) picks.push(m);
  for (const m of ranked) if (!picks.includes(m)) picks.push(m);
  const slots = new Array(MAX_COMPARE).fill(null);
  picks.slice(0, MAX_COMPARE).forEach((m, i) => { slots[i] = m.id; });
  return slots;
}

function newSession() {
  togglePlay(false);
  teardownCharts();
  State.session = null;
  history.replaceState(null, '', location.pathname);
  document.title = 'TechPower';
  $('dashboard-view').hidden = true;
  $('upload-view').hidden = false;
  clearFiles();
}

function renderHeader(d) {
  $('match-title').textContent = d.match_name || 'Match';
  const phases = d.match_segments.filter(s => s.type !== 'disabled')
    .map(s => `${s.type === 'auto' ? 'Auto' : 'Teleop'} ${s.start.toFixed(0)}–${s.end.toFixed(0)} s`);
  $('match-meta').textContent = phases.length
    ? phases.join(', ')
    : 'Robot was never enabled in this log.';

  const w = $('warnings');
  w.hidden = !d.warnings?.length;
  w.innerHTML = (d.warnings || []).map(m => `<li>${esc(m)}</li>`).join('');
}

function renderReadouts(d) {
  const lowV = d.min_voltage;
  const items = [
    { label: 'Lowest voltage', value: fmt(lowV, 2), unit: 'V', alarm: lowV != null && lowV < 7 },
    { label: 'Brownouts', value: d.brownout_count ?? 0, alarm: d.brownout_count > 0, brownout: d.brownout_count > 0 },
    { label: `Under ${d.thresholds.sag_voltage} V`, value: fmt(d.sag_seconds, 1), unit: 's' },
    { label: 'Energy used', value: fmt(d.total_energy_wh, 1), unit: 'Wh' },
    { label: 'Charge used', value: fmt(d.charge_ah, 2), unit: 'Ah' },
    { label: 'Peak draw', value: fmt(d.peak_current, 0), unit: 'A' },
    { label: 'Average draw', value: fmt(d.avg_current, 1), unit: 'A' },
    { label: 'Battery resistance', value: fmt(d.battery?.resistance_mohm, 1), unit: 'mΩ' },
  ];
  $('readouts').innerHTML = items.map(c => `
    <div class="readout${c.alarm ? ' alarm' : ''}">
      <dt>${c.label}</dt>
      <dd>${c.brownout
        ? `<button class="link-num" id="next-brownout" title="Jump to the next brownout">${c.value}</button>`
        : c.value}${c.unit ? `<small>${c.unit}</small>` : ''}</dd>
    </div>`).join('');
  $('next-brownout')?.addEventListener('click', jumpToNextBrownout);
}

function jumpToNextBrownout() {
  const events = State.session.brownout_events;
  const next = events.find(e => e.time > State.t + 0.05) || events[0];
  if (!next) return;
  const span = State.zoom.max - State.zoom.min;
  if (next.time < State.zoom.min || next.time > State.zoom.max) setZoom(next.time - span / 2, next.time + span / 2);
  seek(next.time);
}

// ─── Scrubber ─────────────────────────────────────────────────────────────────
function renderScrubber(d) {
  const pct = t => (t / d.duration * 100).toFixed(3);
  $('track-segments').innerHTML = d.match_segments.map(s =>
    `<div class="seg seg-${s.type}" style="left:${pct(s.start)}%;width:${pct(s.end - s.start)}%"></div>`).join('');
  $('track-brownouts').innerHTML = d.brownout_events.map(e =>
    `<div class="brownout-tick" style="left:${pct(e.time)}%"></div>`).join('');

  const step = [5, 10, 15, 30, 60, 120].find(s => d.duration / s <= 12) || 300;
  let ticks = '';
  for (let t = 0; t <= d.duration - step * 0.4; t += step) ticks += `<span style="left:${pct(t)}%">${t} s</span>`;
  $('ticks').innerHTML = ticks;
  $('track').setAttribute('aria-valuemax', d.duration.toFixed(1));
}

function phaseAt(t) {
  const s = State.session.match_segments.find(s => t >= s.start && t <= s.end);
  return s ? s.type : 'disabled';
}

function seek(t) {
  if (!State.session) return;
  State.t = clamp(t, 0, State.session.duration);
  queueFrame();
}

function setZoom(min, max) {
  const dur = State.session.duration;
  const span = clamp(max - min, Math.min(MIN_ZOOM_S, dur), dur);
  min = clamp((min + max) / 2 - span / 2, 0, dur - span);
  State.zoom = { min, max: min + span };
  State.zoomDirty = true;
  queueFrame();
}

function zoomAt(pivot, factor) {
  const { min, max } = State.zoom;
  const span = max - min;
  const next = clamp(span * factor, MIN_ZOOM_S, State.session.duration);
  const lo = pivot - (pivot - min) * next / span;
  setZoom(lo, lo + next);
}

function panBy(seconds) {
  setZoom(State.zoom.min + seconds, State.zoom.max + seconds);
}

const resetZoom = () => setZoom(0, State.session.duration);

// Zoom around the cursor when it's in view, otherwise around the middle of the view.
function zoomStep(factor) {
  const { min, max } = State.zoom;
  zoomAt(State.t >= min && State.t <= max ? State.t : (min + max) / 2, factor);
}

// All visual updates for cursor and zoom happen here, at most once per frame.
let frameQueued = false;
function queueFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(drawFrame);
}

function drawFrame() {
  frameQueued = false;
  const d = State.session;
  if (!d) return;
  const pct = v => `${(v / d.duration * 100).toFixed(3)}%`;

  $('track-cursor').style.left = pct(State.t);
  $('track').setAttribute('aria-valuenow', State.t.toFixed(1));
  $('clock').innerHTML = `${State.t.toFixed(2)} <small>/ ${d.duration.toFixed(0)} s</small>`;
  const phase = phaseAt(State.t);
  const pill = $('phase-pill');
  pill.dataset.phase = phase;
  pill.textContent = phase[0].toUpperCase() + phase.slice(1);

  const zoomed = State.zoom.min > 0.001 || State.zoom.max < d.duration - 0.001;
  const win = $('zoom-window');
  win.hidden = !zoomed;
  win.style.left = pct(State.zoom.min);
  win.style.width = pct(State.zoom.max - State.zoom.min);
  $('reset-zoom-btn').hidden = !zoomed;

  if (State.tab === 'timeline') {
    if (State.zoomDirty) applyZoomToCharts();   // cursors get placed by the afterRender hook
    else Object.values(State.charts).forEach(placeCursor);
    updateLive();
  }
}

function applyZoomToCharts() {
  State.zoomDirty = false;
  for (const c of Object.values(State.charts)) {
    c.options.scales.x.min = State.zoom.min;
    c.options.scales.x.max = State.zoom.max;
    c.update('none');
  }
}

// ─── Playback ─────────────────────────────────────────────────────────────────
let lastTick = null;
function togglePlay(force) {
  State.playing = force ?? !State.playing;
  const btn = $('play-btn');
  btn.setAttribute('aria-label', State.playing ? 'Pause' : 'Play');
  $('play-icon').innerHTML = State.playing
    ? '<path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/>'
    : '<path d="M4 2.5v11l9-5.5z"/>';
  if (!State.playing || !State.session) return;
  if (State.t >= State.session.duration) State.t = 0;
  lastTick = null;
  requestAnimationFrame(playTick);
}

function playTick(ts) {
  if (!State.playing || !State.session) return;
  if (lastTick !== null) {
    const t = State.t + (ts - lastTick) / 1000 * State.speed;
    if (t >= State.session.duration) { seek(State.session.duration); togglePlay(false); return; }
    seek(t);
    const { min, max } = State.zoom;
    if (t > max || t < min) setZoom(t - (max - min) * 0.1, t + (max - min) * 0.9);
  }
  lastTick = ts;
  requestAnimationFrame(playTick);
}

function cycleSpeed() {
  const speeds = [1, 2, 4, 0.5];
  State.speed = speeds[(speeds.indexOf(State.speed) + 1) % speeds.length];
  $('speed-btn').textContent = `${State.speed}×`;
}

// ─── Charts ───────────────────────────────────────────────────────────────────
const pointCache = new WeakMap();
function points(arr) {
  let pts = pointCache.get(arr);
  if (!pts) {
    const time = State.session.timeline.time;
    pts = arr.map((y, i) => ({ x: time[i], y }));
    pointCache.set(arr, pts);
  }
  return pts;
}

// Phase shading and brownout lines behind the data.
const bandsPlugin = {
  id: 'bands',
  beforeDatasetsDraw(chart) {
    const d = State.session, th = State.theme;
    const { ctx, chartArea: a, scales: { x } } = chart;
    if (!a || !d) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(a.left, a.top, a.width, a.height); ctx.clip();
    for (const s of d.match_segments) {
      if (s.type === 'disabled') continue;
      const x0 = x.getPixelForValue(s.start), x1 = x.getPixelForValue(s.end);
      ctx.fillStyle = th[s.type];
      ctx.fillRect(x0, a.top, x1 - x0, a.height);
    }
    ctx.strokeStyle = th.critical;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (const b of d.brownout_events) {
      const px = Math.round(x.getPixelForValue(b.time)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
    }
    ctx.restore();
  },
};

// The cursor is a DOM line over the canvas, so moving it never redraws the chart.
const cursorPlugin = { id: 'cursor', afterRender: chart => placeCursor(chart) };

function placeCursor(chart) {
  const el = chart.$cursor, a = chart.chartArea;
  if (!el || !a) return;
  const px = chart.scales.x.getPixelForValue(State.t);
  const on = px >= a.left - 0.5 && px <= a.right + 0.5;
  el.style.display = on ? 'block' : 'none';
  if (on) {
    el.style.transform = `translateX(${px}px)`;
    el.style.top = `${a.top}px`;
    el.style.height = `${a.height}px`;
  }
}

function timeChart(id, series, { yMin, yMax, legend = series.length > 1 } = {}) {
  const canvas = $(id);
  const th = State.theme;
  const plot = canvas.parentElement;
  const cursor = plot.querySelector('.plot-cursor') || plot.appendChild(Object.assign(
    document.createElement('div'), { className: 'plot-cursor' }));
  cursor.style.left = '0';

  const chart = new Chart(canvas, {
    type: 'line',
    data: { datasets: series.map(datasetFor) },
    options: {
      parsing: false,
      normalized: true,
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        decimation: { enabled: true, algorithm: 'min-max' },
        legend: {
          display: legend, position: 'bottom', align: 'start',
          labels: { color: th.ink2, boxWidth: 12, boxHeight: 12, font: { size: 12 } },
        },
        tooltip: {
          backgroundColor: th.surface, borderColor: th.rule, borderWidth: 1,
          titleColor: th.ink, bodyColor: th.ink2, padding: 8, boxPadding: 4,
          titleFont: { weight: '600' },
          callbacks: {
            title: items => `${items[0]?.parsed.x.toFixed(2)} s`,
            label: c => ` ${c.dataset.label}: ${fmt(c.parsed.y, 1)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear', min: State.zoom.min, max: State.zoom.max,
          grid: { color: th.grid }, border: { display: false },
          ticks: { color: th.ink3, maxTicksLimit: 10, maxRotation: 0, callback: v => `${Math.round(v)} s` },
        },
        y: {
          min: yMin, max: yMax,
          grid: { color: th.grid }, border: { display: false },
          ticks: { color: th.ink3, maxTicksLimit: 6 },
        },
      },
    },
    plugins: [bandsPlugin, cursorPlugin],
  });
  chart.$cursor = cursor;
  placeCursor(chart);
  State.charts[id] = chart;
  return chart;
}

function datasetFor(s) {
  return {
    label: s.label, data: points(s.data),
    borderColor: s.color, backgroundColor: s.color,
    borderWidth: s.width ?? 1.5, pointRadius: 0, pointHoverRadius: 3,
    tension: 0, spanGaps: false, fill: false,
  };
}

function teardownCharts() {
  Object.values(State.charts).forEach(c => c.destroy());
  State.charts = {};
  document.querySelectorAll('.plot-cursor').forEach(el => { el.style.display = 'none'; });
}

function extent(arr) {
  let lo = Infinity, hi = -Infinity;
  for (const v of arr) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo <= hi ? [lo, hi] : [0, 1];
}

function buildTimelineCharts() {
  const d = State.session, tl = d.timeline, th = State.theme;

  const [vLo, vHi] = extent(tl.battery_voltage);
  timeChart('chart-voltage',
    [{ label: 'Battery voltage', data: tl.battery_voltage, color: th.ink, width: 1.5 }],
    { yMin: Math.floor(Math.min(vLo, 7) - 0.5), yMax: Math.ceil(vHi + 0.3) });

  const current = [{ label: 'Whole robot (PDH)', data: tl.battery_current, color: th.series[1] }];
  for (const [sid, arr] of Object.entries(d.busTotals)) {
    const idx = d.subsystemIndex[sid] ?? 0;
    const name = d.subsystems?.[idx]?.name ?? sid;
    current.push({ label: name, data: arr, color: subsystemColorValue(idx) });
  }
  timeChart('chart-current', current, { yMin: 0 });

  $('motor-charts').hidden = !d.hasMotorData;
  $('no-motor-data').hidden = d.hasMotorData;
  if (d.hasMotorData) {
    MOTOR_CHARTS.forEach(([id, key, opts]) => timeChart(id, motorSeries(key), { ...opts, legend: true }));
    noteMissing();
  }
}

const MOTOR_CHARTS = [
  ['chart-supply', 'supply_current_by_motor', {}],
  ['chart-stator', 'stator_current_by_motor', {}],
  ['chart-motor-voltage', 'motor_voltage_by_motor', {}],
  ['chart-temp', 'temp_by_motor', {}],
];

function motorSeries(key) {
  const d = State.session, src = d.timeline[key] || {};
  return State.slots.flatMap((id, slot) => (id && src[id])
    ? [{ label: d.motorById[id].name, data: src[id], color: State.theme.series[slot] }]
    : []);
}

function noteMissing() {
  const d = State.session;
  for (const [id, key] of MOTOR_CHARTS) {
    const card = $(id).closest('.card');
    const note = card.querySelector('.chart-note') || card.insertBefore(
      Object.assign(document.createElement('p'), { className: 'sub chart-note' }), card.querySelector('.plot'));
    const missing = State.slots.filter(mid => mid && !d.timeline[key]?.[mid]).map(mid => d.motorById[mid].name);
    note.textContent = missing.length ? `Not logged for ${missing.join(', ')}.` : '';
    note.hidden = !missing.length;
  }
}

function updateMotorCharts() {
  for (const [id, key] of MOTOR_CHARTS) {
    const c = State.charts[id];
    if (!c) continue;
    c.data.datasets = motorSeries(key).map(datasetFor);
    c.update('none');
  }
  noteMissing();
}

// ─── Values at cursor (also the motor picker) ─────────────────────────────────
function renderLiveTable(d) {
  const groups = new Map();
  d.motors.forEach(m => {
    if (!groups.has(m.subsystem_id)) groups.set(m.subsystem_id, []);
    groups.get(m.subsystem_id).push(m);
  });
  let html = '';
  for (const [sid, motors] of groups) {
    html += `<tr class="group-row" data-bus="${esc(sid)}"><td>${esc(motors[0].subsystem)}</td>`
      + `<td title="Total supply current on this bus">–</td><td colspan="2"></td></tr>`;
    for (const m of motors) {
      html += `<tr class="motor${m.has_data ? '' : ' no-data'}" data-id="${esc(m.id)}">
        <td><button class="pick" aria-pressed="false" ${m.has_data ? '' : 'disabled'}
          title="${m.has_data ? 'Compare in the motor charts' : 'No data in the logs'}"><span class="swatch"></span>${esc(m.name)}</button></td>
        <td>–</td><td>–</td><td>–</td></tr>`;
    }
  }
  $('live-body').innerHTML = html;
  State.liveRows = [...$('live-body').querySelectorAll('tr.motor')].map(tr => ({
    id: tr.dataset.id, btn: tr.querySelector('.pick'), cells: tr.querySelectorAll('td'),
  }));
  State.liveBusCells = [...$('live-body').querySelectorAll('tr.group-row')].map(tr => ({
    bus: tr.dataset.bus, cell: tr.children[1],
  }));
  paintSelection();
}

function paintSelection() {
  for (const r of State.liveRows) {
    const slot = State.slots.indexOf(r.id);
    r.btn.setAttribute('aria-pressed', String(slot >= 0));
    r.btn.querySelector('.swatch').style.background = slot >= 0 ? `var(--series-${slot + 1})` : '';
  }
  const full = State.slots.every(Boolean);
  $('motor-pick-hint').textContent = full
    ? 'Comparing four motors. Unselect one in Values at cursor to swap it.'
    : 'Comparing the selected motors. Pick up to four in Values at cursor.';
}

function toggleMotor(id) {
  const slot = State.slots.indexOf(id);
  if (slot >= 0) State.slots[slot] = null;
  else {
    const free = State.slots.indexOf(null);
    if (free < 0) return;
    State.slots[free] = id;
  }
  paintSelection();
  updateMotorCharts();
}

function updateLive() {
  const d = State.session, tl = d.timeline;
  const i = clamp(Math.round(State.t / d.dt), 0, tl.time.length - 1);
  if (i === State.liveIdx) return;
  State.liveIdx = i;
  drawField(i);

  $('live-time').textContent = `${State.t.toFixed(2)} s`;
  const v = tl.battery_voltage[i], a = tl.battery_current[i];
  $('live-batt-v').textContent = v == null ? '–' : `${fmt(v, 2)} V`;
  $('live-batt-a').textContent = a == null ? '–' : `${fmt(a, 0)} A`;

  const sup = tl.supply_current_by_motor, sta = tl.stator_current_by_motor, tmp = tl.temp_by_motor;
  const breaker = d.thresholds.breaker_amps;
  for (const b of State.liveBusCells) b.cell.textContent = fmt(d.busTotals[b.bus]?.[i]);
  for (const r of State.liveRows) {
    const s = sup?.[r.id]?.[i];
    r.cells[1].textContent = fmt(s);
    r.cells[1].className = s != null && Math.abs(s) > breaker ? 'val-warn' : '';
    r.cells[2].textContent = fmt(sta?.[r.id]?.[i]);
    const t = tmp?.[r.id]?.[i];
    r.cells[3].textContent = fmt(t, 0);
    r.cells[3].className = tempClass(t);
  }
}

// ─── Field ────────────────────────────────────────────────────────────────────
// Blue-origin field metres → CSS pixels on the field image (same mapping as AdvantageScope).
function fieldPx(x, y) {
  const f = State.field, [tlx, tly] = f.top_left, [brx, bry] = f.bottom_right;
  const fx = x / f.length_m * (brx - tlx), fy = y / f.width_m * (bry - tly);
  const [px, py] = f.blue_wall === 'right' ? [brx - fx, tly + fy] : [tlx + fx, bry - fy];
  return [px * State.fieldScale, py * State.fieldScale];
}

function setupField(field) {
  const el = $('field');
  if (!field) return;
  State.field = field;
  $('field-img').src = field.image;
  el.style.aspectRatio = `${field.image_size[0]} / ${field.image_size[1]}`;
  const canvas = $('field-canvas');
  new ResizeObserver(() => {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(el.clientWidth * dpr);
    canvas.height = Math.round(el.clientHeight * dpr);
    State.fieldScale = el.clientWidth / State.field.image_size[0];
    if (State.session && State.liveIdx >= 0) drawField(State.liveIdx);
  }).observe(el);
  canvas.addEventListener('click', e => {
    const d = State.session;
    if (!d) return;
    const r = canvas.getBoundingClientRect();
    const hit = d.brownout_events.find(b => b.x != null &&
      Math.hypot(...fieldPx(b.x, b.y).map((v, k) => v - (k ? e.clientY - r.top : e.clientX - r.left))) < 8);
    if (hit) showMoment(hit.time);
  });
}

function drawField(i) {
  const d = State.session, tl = d?.timeline, canvas = $('field-canvas');
  if (!canvas || !State.field || !tl?.pose_x) return;
  const ctx = canvas.getContext('2d'), th = State.theme;
  const dpr = canvas.width / (canvas.clientWidth || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const X = tl.pose_x, Y = tl.pose_y, Hd = tl.pose_heading;

  // Planned auto path while auto is running
  if (phaseAt(State.t) === 'auto') {
    const path = [...(d.trajectories || [])].reverse().find(p => p.time <= State.t + 0.05);
    if (path) {
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      path.points.forEach(([x, y], k) => { const [px, py] = fieldPx(x, y); k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.stroke();
      ctx.restore();
    }
  }

  // Trail, shaded by robot current draw
  const n = Math.round(TRAIL_S / d.dt), amps = tl.battery_current, peak = d.peak_current || 1;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = th.series[1];
  for (let k = Math.max(1, i - n); k <= i; k++) {
    if (X[k] == null || X[k - 1] == null || Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]) > POSE_JUMP_M) continue;
    const fade = (k - (i - n)) / n;
    ctx.globalAlpha = (0.2 + 0.8 * clamp((amps[k] ?? 0) / peak, 0, 1)) * (0.35 + 0.65 * fade);
    const [ax, ay] = fieldPx(X[k - 1], Y[k - 1]), [bx, by] = fieldPx(X[k], Y[k]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  ctx.restore();

  // Brownout locations
  ctx.save();
  ctx.strokeStyle = th.critical;
  ctx.fillStyle = th.critical;
  ctx.lineWidth = 2;
  for (const b of d.brownout_events) {
    if (b.x == null) continue;
    const [px, py] = fieldPx(b.x, b.y);
    ctx.beginPath(); ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    Math.abs(b.time - State.t) < 0.5 ? ctx.fill() : ctx.stroke();
  }
  ctx.restore();

  // Robot: bumper outline with a line to the front
  const x = X[i], y = Y[i], h = Hd[i];
  if (x != null && y != null && h != null) {
    const [L, W] = State.field.robot_size_m, c = Math.cos(h), s = Math.sin(h);
    const at = (fx, fy) => fieldPx(x + fx * c - fy * s, y + fx * s + fy * c);
    const corners = [[L / 2, W / 2], [L / 2, -W / 2], [-L / 2, -W / 2], [-L / 2, W / 2]].map(([a, b]) => at(a, b));
    ctx.save();
    ctx.beginPath();
    corners.forEach(([px, py], k) => k ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
    ctx.closePath();
    ctx.fillStyle = th.brand;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    const [cx, cy] = at(0, 0), [nx, ny] = at(L / 2, 0);
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny); ctx.stroke();
    ctx.restore();
  }

  const deg = h == null ? null : ((h * 180 / Math.PI + 540) % 360) - 180;
  $('pose-x').textContent = x == null ? '–' : `${fmt(x, 2)} m`;
  $('pose-y').textContent = y == null ? '–' : `${fmt(y, 2)} m`;
  $('pose-h').textContent = deg == null ? '–' : `${fmt(deg, 0)}°`;
  $('pose-v').textContent = tl.speed?.[i] == null ? '–' : `${fmt(tl.speed[i], 1)} m/s`;
}

const tempClass = t => t == null ? '' : t >= CRIT_TEMP ? 'val-crit' : t >= WARN_TEMP ? 'val-warn' : '';

// ─── Energy ───────────────────────────────────────────────────────────────────
function barRow(label, sub, value, max, color, digits = 1, mark = null) {
  const w = max > 0 ? clamp(value / max * 100, 0, 100) : 0;
  const m = mark != null && max > 0 ? `<div class="bar-mark" style="left:${clamp(mark / max * 100, 0, 100)}%"></div>` : '';
  return `<div class="bar-row">
    <div class="label" title="${esc(label)}">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${w.toFixed(2)}%;background:${color}"></div>${m}</div>
    <div class="value">${fmt(value, digits)}</div>
  </div>`;
}

function renderEnergy(d) {
  const motorWh = d.motors.reduce((s, m) => s + (m.energy_wh ?? 0), 0);
  const total = d.total_energy_wh;
  const wh = v => `<b>${fmt(v, 1)}&nbsp;Wh</b>`;
  let lede;
  if (total == null) lede = `Robot current wasn't logged, so whole-robot energy is unavailable. Motors drew ${wh(motorWh)}.`;
  else if (!d.hasMotorData) lede = `${wh(total)} drawn from the battery. Add the CANivore logs to see which motors used it.`;
  else lede = `${wh(total)} drawn from the battery. Motors on the CANivores account for ${wh(motorWh)}; the other
    ${wh(Math.max(0, total - motorWh))} went to the roboRIO, radio, sensors and other PDH loads.`;
  $('energy-lede').innerHTML = lede;

  const b = d.battery;
  $('battery-facts').innerHTML = [
    ['Resting voltage', b ? `${fmt(b.resting_voltage, 2)} V` : '–'],
    ['Internal resistance', b ? `${fmt(b.resistance_mohm, 1)} mΩ` : '–'],
    ['Charge used', `${fmt(d.charge_ah, 2)} Ah`],
    [`Time under ${d.thresholds.sag_voltage} V`, `${fmt(d.sag_seconds, 1)} s`],
  ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('');
  $('battery-note').hidden = !!b;

  const phases = d.energy_by_segment;
  const pMax = Math.max(0, ...phases.map(p => p.wh ?? 0));
  $('energy-phases').innerHTML = phases.length ? phases.map(p => barRow(
    p.type[0].toUpperCase() + p.type.slice(1), `${p.start.toFixed(0)}–${p.end.toFixed(0)} s`,
    p.wh ?? 0, pMax, `var(--${p.type}-solid)`)).join('') : '<p class="empty">No battery current in the log.</p>';

  const withEnergy = d.motors.filter(m => m.energy_wh != null);
  const mMax = Math.max(0, ...withEnergy.map(m => m.energy_wh));
  let html = '';
  (d.subsystems || []).forEach((sub, idx) => {
    const ms = withEnergy.filter(m => m.subsystem_id === sub.id).sort((a, b) => b.energy_wh - a.energy_wh);
    if (!ms.length) return;
    html += `<div class="bar-group">${esc(sub.name)}, ${fmt(d.energy_by_subsystem[sub.id], 1)} Wh</div>`;
    html += ms.map(m => barRow(m.name, '', m.energy_wh, mMax, subsystemColor(idx), 2)).join('');
  });
  $('energy-motors').innerHTML = html || '<p class="empty">No motor data. Add the CANivore hoot logs.</p>';
}

// ─── Brownouts ───────────────────────────────────────────────────────────────
function renderBrownouts(d) {
  const events = d.brownout_events;
  const name = id => d.motorById[id]?.name ?? id;
  $('brownouts-table').hidden = !events.length;
  if (!events.length) {
    $('brownout-summary').textContent = `No brownouts. The lowest voltage was ${fmt(d.min_voltage, 2)} V.`;
    return;
  }
  const total = events.reduce((s, e) => s + (e.duration ?? 0), 0);
  const counts = {};
  events.forEach(e => e.top_motors.forEach(m => { counts[m.id] = (counts[m.id] || 0) + 1; }));
  const [worst, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [];
  $('brownout-summary').textContent = `${events.length} brownout${events.length > 1 ? 's' : ''}, ${fmt(total, 2)} s in total.`
    + (worst ? ` ${name(worst)} was one of the three biggest supply draws in ${n} of them.` : '');
  $('brownouts-table').querySelector('tbody').innerHTML = events.map(e => `<tr>
    <td><button class="link-num" data-time="${e.time}">${fmt(e.time, 2)} s</button></td>
    <td>${fmt((e.duration ?? 0) * 1000, 0)} ms</td>
    <td>${fmt(e.min_voltage, 2)} V</td>
    <td>${fmt(e.peak_current, 0)} A</td>
    <td class="motors-cell">${e.top_motors.map(m => `${esc(name(m.id))} ${fmt(m.amps, 0)} A`).join(', ') || 'No motor data at this time'}</td>
  </tr>`).join('');
}

function showMoment(t) {
  switchTab('timeline');
  setZoom(t - 5, t + 5);
  seek(t);
  document.querySelector('.scrubber').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ─── Temperature ──────────────────────────────────────────────────────────────
function renderTemperature(d) {
  const withTemp = d.motors.filter(m => m.max_temp != null).sort((a, b) => b.max_temp - a.max_temp);
  const scale = Math.max(100, ...withTemp.map(m => m.max_temp));
  const color = t => t >= CRIT_TEMP ? 'var(--critical)' : t >= WARN_TEMP ? 'var(--warning)' : 'var(--series-3)';
  $('temp-bars').innerHTML = withTemp.length
    ? withTemp.map(m => barRow(m.name, '', m.max_temp, scale, color(m.max_temp), 0, m.avg_temp)).join('')
    : '<p class="empty">No motor temperature in these logs.</p>';
  const missing = d.motors.filter(m => m.max_temp == null).map(m => m.name);
  $('temp-missing').textContent = missing.length && withTemp.length ? `No temperature logged for ${missing.join(', ')}.` : '';
}

// ─── Motors table ─────────────────────────────────────────────────────────────
const tableSort = { key: 'energy_wh', dir: -1 };

function renderMotorTable(d) {
  const { key, dir } = tableSort;
  const rows = [...d.motors].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null) return y == null ? 0 : 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
  document.querySelectorAll('#motor-table th').forEach(th => {
    if (th.dataset.key === key) th.setAttribute('aria-sort', dir > 0 ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
  });
  document.querySelector('#motor-table tbody').innerHTML = rows.map(m => `<tr>
    <td>${esc(m.name)}</td>
    <td><span class="badge">${esc(m.subsystem)}</span></td>
    <td>${m.channel ?? '–'}</td>
    <td>${fmt(m.peak_supply_current)}</td>
    <td>${fmt(m.avg_supply_current)}</td>
    <td>${fmt(m.rms_supply_current)}</td>
    <td class="${m.over_breaker_s > 0 ? 'val-warn' : ''}">${fmt(m.over_breaker_s)}</td>
    <td>${fmt(m.peak_stator_current)}</td>
    <td class="${tempClass(m.max_temp)}">${fmt(m.max_temp, 0)}</td>
    <td>${fmt(m.avg_temp, 0)}</td>
    <td>${fmt(m.energy_wh, 2)}</td>
  </tr>`).join('');
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  State.tab = tab;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.has('example')) {
    if (tab === 'timeline') hash.delete('tab'); else hash.set('tab', tab);
    history.replaceState(null, '', `#${hash}`);
  }
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab; });
  if (tab === 'timeline' && State.session) {
    if (!State.charts['chart-voltage']) buildTimelineCharts();
    else State.zoomDirty = true;
    State.liveIdx = -1;
    queueFrame();
  }
}

function rebuildForTheme() {
  State.theme = readTheme();
  if (!State.session) return;
  teardownCharts();
  if (State.tab === 'timeline') buildTimelineCharts();
}

// ─── Input ────────────────────────────────────────────────────────────────────
function bindTrack() {
  const track = $('track');
  const timeAt = e => {
    const r = track.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * State.session.duration;
  };
  track.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !State.session) return;
    track.setPointerCapture(e.pointerId);
    seek(timeAt(e));
  });
  track.addEventListener('pointermove', e => {
    if (track.hasPointerCapture(e.pointerId)) seek(timeAt(e));
  });
  track.addEventListener('wheel', e => {
    if (!State.session) return;
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) panBy(e.deltaX / track.clientWidth * State.session.duration);
    else zoomAt(timeAt(e), e.deltaY > 0 ? 1.25 : 0.8);
  }, { passive: false });
  track.addEventListener('dblclick', resetZoom);
}

// Drag across a chart to zoom into that span; a click without dragging moves the cursor.
function bindChartBrush() {
  document.querySelectorAll('.plot canvas').forEach(canvas => {
    const box = canvas.parentElement.appendChild(Object.assign(document.createElement('div'), { className: 'brush' }));
    let start = null;
    const xAt = e => e.clientX - canvas.getBoundingClientRect().left;
    const area = () => State.charts[canvas.id]?.chartArea;

    canvas.addEventListener('pointerdown', e => {
      const a = area();
      if (!a || e.button !== 0) return;
      const x = xAt(e);
      if (x < a.left || x > a.right) return;
      start = x;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      const a = area();
      if (start === null || !a) return;
      const x = clamp(xAt(e), a.left, a.right);
      box.style.display = Math.abs(x - start) > 4 ? 'block' : 'none';
      box.style.left = `${Math.min(x, start)}px`;
      box.style.width = `${Math.abs(x - start)}px`;
      box.style.top = `${a.top}px`;
      box.style.height = `${a.height}px`;
    });
    canvas.addEventListener('pointerup', e => {
      const chart = State.charts[canvas.id];
      if (start === null || !chart) return;
      const a = chart.chartArea, x = clamp(xAt(e), a.left, a.right), from = start;
      start = null;
      box.style.display = 'none';
      const scale = chart.scales.x;
      if (Math.abs(x - from) > 4) setZoom(scale.getValueForPixel(Math.min(x, from)), scale.getValueForPixel(Math.max(x, from)));
      else seek(scale.getValueForPixel(x));
    });
    canvas.addEventListener('pointercancel', () => { start = null; box.style.display = 'none'; });
  });
}

function bindChartWheel() {
  document.querySelectorAll('.plot canvas').forEach(canvas => {
    canvas.addEventListener('wheel', e => {
      const chart = State.charts[canvas.id];
      if (!chart) return;
      const span = State.zoom.max - State.zoom.min;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        zoomAt(chart.scales.x.getValueForPixel(e.clientX - r.left), e.deltaY > 0 ? 1.25 : 0.8);
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        panBy(e.deltaX / chart.chartArea.width * span);
      }
    }, { passive: false });
    canvas.addEventListener('dblclick', () => State.session && resetZoom());
  });
}

function onKey(e) {
  if (!State.session || $('dashboard-view').hidden) return;
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
  const step = e.shiftKey ? 5 : 1;
  switch (e.key) {
    case ' ': togglePlay(); break;
    case 'ArrowLeft': seek(State.t - step); break;
    case 'ArrowRight': seek(State.t + step); break;
    case 'Home': seek(0); break;
    case 'End': seek(State.session.duration); break;
    case 'Escape': resetZoom(); break;
    case '+': case '=': zoomStep(0.5); break;
    case '-': zoomStep(2); break;
    default: return;
  }
  e.preventDefault();
}

function bindDropZone() {
  const zone = $('drop-zone'), input = $('file-input');
  input.addEventListener('change', () => addFiles(input.files));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    addFiles(e.dataTransfer.files);
  });
  // Dropping a file anywhere else shouldn't navigate away from the app.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function renderExamples(sessions) {
  $('examples').hidden = !sessions.length;
  $('example-btns').replaceChildren(...sessions.map(sess => {
    const b = Object.assign(document.createElement('button'), { className: 'btn example-btn', textContent: sess.name });
    b.addEventListener('click', () => loadExample(sess.id));
    return b;
  }));
}

async function init() {
  State.theme = readTheme();
  if (location.protocol === 'file:') {
    setStatus('Open TechPower through a web server, not as a file. See the README.', true);
    return;
  }
  if (typeof Chart === 'undefined') {
    setStatus('Chart library failed to load. Check js/vendor/chart.umd.min.js.', true);
    return;
  }
  try {
    const res = await fetch('config.json');
    if (!res.ok) throw new Error(res.status);
    State.config = await res.json();
  } catch {
    setStatus("Couldn't load config.json.", true);
    return;
  }

  $('app-version').textContent = `v${State.config.app.version}`;
  renderExamples(State.config.example_logs?.sessions || []);
  Chart.defaults.font.family = "'Barlow', system-ui, sans-serif";
  setupField(State.config.field);
  bindDropZone();
  bindTrack();
  bindChartWheel();
  bindChartBrush();
  $('zoom-in-btn').addEventListener('click', () => zoomStep(0.5));
  $('zoom-out-btn').addEventListener('click', () => zoomStep(2));
  $('analyze-btn').addEventListener('click', analyzeFiles);
  $('clear-btn').addEventListener('click', clearFiles);
  $('new-session-btn').addEventListener('click', newSession);
  $('play-btn').addEventListener('click', () => togglePlay());
  $('speed-btn').addEventListener('click', cycleSpeed);
  $('reset-zoom-btn').addEventListener('click', resetZoom);
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('live-body').addEventListener('click', e => {
    const tr = e.target.closest('tr.motor');
    if (tr && !tr.classList.contains('no-data')) toggleMotor(tr.dataset.id);
  });
  document.querySelector('#motor-table thead').addEventListener('click', e => {
    const key = e.target.closest('th')?.dataset.key;
    if (!key || !State.session) return;
    tableSort.dir = tableSort.key === key ? -tableSort.dir : (key === 'name' || key === 'subsystem' ? 1 : -1);
    tableSort.key = key;
    renderMotorTable(State.session);
  });
  document.addEventListener('keydown', onKey);
  $('brownouts-table').addEventListener('click', e => {
    const t = e.target.closest('[data-time]')?.dataset.time;
    if (t != null) showMoment(Number(t));
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rebuildForTheme);

  const example = new URLSearchParams(location.hash.slice(1)).get('example');
  if (example) loadExample(example);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
