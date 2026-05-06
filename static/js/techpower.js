/* TechPower v1.2.0 */

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  session: null,
  currentTime: 0,
  playing: false,
  activeTab: 'timeline',
  charts: {},
  zoom: { xMin: 0, xMax: 1 },
};

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel) || [];

const COLORS = {
  auto: '#f59e0b', teleop: '#3b82f6', disabled: '#374151',
  brownout: '#ef4444', voltage: '#34d399', current: '#f97316',
  stator: '#a78bfa', supply: '#f97316', temp: '#fb923c',
  swerve: '#3b82f6', subsystems: '#f97316',
};

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ─── Upload / Drop zone ───────────────────────────────────────────────────────
function initDropZone() {
  const zone = $('drop-zone'), input = $('file-input');
  if (!zone || !input) return;
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', e => handleFiles(e.target.files));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
}

function handleFiles(files) {
  if (!files.length) return;
  const list = Array.from(files);
  $('upload-status').innerHTML = list.map(f => `
    <div class="file-chip">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>${f.name}
    </div>`).join('');
  uploadFiles(list);
}

async function uploadFiles(files) {
  const btn = $('analyze-btn'), prog = $('upload-progress');
  btn.disabled = true; btn.textContent = 'Analyzing…';
  prog.style.display = 'block';
  const fd = new FormData();
  files.forEach(f => fd.append('logs', f));
  try {
    const res = await fetch('/api/analyze', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    State.session = data;
    renderDashboard(data);
  } catch (err) {
    showError(err.message || 'Upload failed');
  } finally {
    btn.disabled = false; btn.textContent = 'Analyze';
    prog.style.display = 'none';
  }
}

async function loadExample(sessionId) {
  const btn = $('analyze-btn'), prog = $('upload-progress');
  btn.disabled = true; prog.style.display = 'block';
  showUploadState('loading', `Loading ${sessionId}…`);
  try {
    const res = await fetch(`/api/example/${sessionId}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    State.session = data;
    renderDashboard(data);
  } catch (err) {
    showError(err.message || 'Failed to load example');
  } finally {
    btn.disabled = false; prog.style.display = 'none';
  }
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function renderDashboard(data) {
  $('upload-panel').style.display    = 'none';
  $('dashboard-panel').style.display = 'block';
  $('match-title').textContent = data.match_name || 'Match';
  $('match-meta').textContent  = `${data.duration?.toFixed(1) ?? '–'}s · ${data.match_segments?.length ?? 0} segments`;

  const dha = $('dash-header-actions');
  if (dha) dha.style.display = 'block';

  renderSummaryCards(data);
  renderTimeBar(data);

  // Show all panels briefly so Chart.js can measure canvas sizes
  $$('.tab-panel').forEach(p => { p.style.display = 'block'; });

  ensureTimelineCanvases();
  ensureEnergyCanvases();
  renderTimelineCharts(data);
  renderEnergyPanel(data);
  renderHeatmap(data);
  renderDetailTable(data);

  // Patch donut total
  const totalEl = $('total-wh-display');
  if (totalEl) {
    const subsysSum = Object.values(data.energy_by_subsystem || {}).reduce((a,b) => a+b, 0);
    totalEl.textContent = subsysSum > 0 ? subsysSum.toFixed(1) : (data.total_energy_wh?.toFixed(1) ?? '–');
  }

  switchTab('timeline');
}

// ─── Summary cards ────────────────────────────────────────────────────────────
function renderSummaryCards(data) {
  const subsysTotal = Object.values(data.energy_by_subsystem || {}).reduce((a,b) => a+b, 0);
  const cards = [
    { label: 'Peak Voltage', value: (data.peak_voltage?.toFixed(2) ?? '–') + ' V' },
    { label: 'Min Voltage',  value: (data.min_voltage?.toFixed(2)  ?? '–') + ' V' },
    { label: 'Total Energy', value: ((subsysTotal || data.total_energy_wh) ?? 0).toFixed(1) + ' Wh' },
    { label: 'Brownouts',    value: data.brownout_count ?? 0, warn: (data.brownout_count ?? 0) > 0 },
    { label: 'Peak Current', value: (data.peak_current?.toFixed(1) ?? '–') + ' A' },
    { label: 'Avg Current',  value: (data.avg_current?.toFixed(1)  ?? '–') + ' A' },
  ];
  $('summary-cards').innerHTML = cards.map(c => `
    <div class="summary-card ${c.warn ? 'card-warn' : ''}">
      <div class="card-label">${c.label}</div>
      <div class="card-value">${c.value}</div>
    </div>`).join('');
}

// ─── Time Bar ─────────────────────────────────────────────────────────────────
function renderTimeBar(data) {
  const container = $('time-bar-container');
  const duration  = data.duration || 1;
  const segments  = data.match_segments || [];
  const brownouts = data.brownout_events || [];

  const trackInner = segments.map(seg => {
    const left  = (seg.start / duration * 100).toFixed(3);
    const width = ((seg.end - seg.start) / duration * 100).toFixed(3);
    return `<div class="seg-block seg-${seg.type}" style="left:${left}%;width:${width}%"
              title="${seg.type} ${seg.start.toFixed(1)}s–${seg.end.toFixed(1)}s"></div>`;
  }).join('');

  const brownoutTicks = brownouts.map(ev => {
    const left = (ev.time / duration * 100).toFixed(3);
    return `<div class="brownout-tick" style="left:${left}%" title="Brownout @ ${ev.time.toFixed(2)}s"></div>`;
  }).join('');

  container.innerHTML = `
    <div class="timebar-wrap">
      <div class="timebar-labels">${buildTimeMarkers(duration)}</div>
      <div class="timebar-track" id="timebar-track">
        <div class="seg-track">${trackInner}</div>
        <div class="brownout-layer">${brownoutTicks}</div>
        <div class="timebar-zoom-overlay" id="timebar-zoom-overlay"></div>
        <div class="timebar-cursor" id="timebar-cursor" style="left:0%"></div>
      </div>
      <div class="timebar-controls">
        <button class="tb-btn" id="play-btn" onclick="togglePlay()">▶</button>
        <span class="tb-time" id="tb-time">0.00 s</span>
        <span class="tb-duration">/ ${duration.toFixed(2)} s</span>
        <button class="tb-btn" onclick="resetZoom()" title="Reset zoom">⊠</button>
        <div class="tb-legend">
          <span class="leg-item"><span class="leg-swatch leg-auto"></span>Auto</span>
          <span class="leg-item"><span class="leg-swatch leg-teleop"></span>Teleop</span>
          <span class="leg-item"><span class="leg-swatch leg-disabled"></span>Disabled</span>
          <span class="leg-item"><span class="leg-swatch leg-brownout"></span>Brownout</span>
          <span class="leg-item" style="color:var(--text-3);font-size:10px">Scroll=zoom · right-drag=pan · dbl-click=reset</span>
        </div>
      </div>
    </div>`;

  State.zoom = { xMin: 0, xMax: duration };

  const track = $('timebar-track');
  let dragging = false;
  const seekFrac = e => {
    const r = track.getBoundingClientRect();
    seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration);
  };
  track.addEventListener('mousedown', e => { if (e.button === 0) { dragging = true; seekFrac(e); } });
  document.addEventListener('mousemove', e => { if (dragging) seekFrac(e); });
  document.addEventListener('mouseup',   e => { if (e.button === 0) dragging = false; });
  track.addEventListener('touchstart', e => seekFrac(e.touches[0]), { passive: true });
  track.addEventListener('touchmove',  e => seekFrac(e.touches[0]), { passive: true });

  // Wheel zoom on timebar
  track.addEventListener('wheel', e => {
    e.preventDefault();
    const r = track.getBoundingClientRect();
    zoomAround((e.clientX - r.left) / r.width, e.deltaY > 0 ? 1.25 : 0.8, duration);
  }, { passive: false });

  // Double-click = reset zoom
  track.addEventListener('dblclick', () => resetZoom());

  // Right-drag = pan
  let panStart = null, panXMin0 = null;
  track.addEventListener('mousedown', e => {
    if (e.button === 2) { e.preventDefault(); panStart = e.clientX; panXMin0 = State.zoom.xMin; }
  });
  document.addEventListener('mousemove', e => {
    if (panStart === null) return;
    const r = track.getBoundingClientRect();
    const dx = (e.clientX - panStart) / r.width * duration;
    const span = State.zoom.xMax - State.zoom.xMin;
    let lo = panXMin0 - dx, hi = lo + span;
    if (lo < 0)        { lo = 0; hi = span; }
    if (hi > duration) { hi = duration; lo = duration - span; }
    applyZoom(lo, hi);
  });
  document.addEventListener('mouseup', e => { if (e.button === 2) panStart = null; });
  track.addEventListener('contextmenu', e => e.preventDefault());
}

function buildTimeMarkers(duration) {
  const step = duration > 120 ? 30 : duration > 60 ? 15 : duration > 30 ? 10 : 5;
  let html = '';
  for (let t = 0; t <= duration; t += step)
    html += `<div class="tb-marker" style="left:${(t/duration*100).toFixed(2)}%">${t}s</div>`;
  return html;
}

function seekTo(t) {
  const duration = State.session?.duration || 1;
  State.currentTime = Math.max(0, Math.min(duration, t));
  const pct = (State.currentTime / duration * 100).toFixed(3);
  const cursor = $('timebar-cursor'), tbTime = $('tb-time');
  if (cursor) cursor.style.left = pct + '%';
  if (tbTime) tbTime.textContent = State.currentTime.toFixed(2) + ' s';
  updateChartCrosshairs();
  updateLiveTable(State.currentTime);
}

function togglePlay() {
  State.playing = !State.playing;
  const btn = $('play-btn');
  if (!btn) return;
  btn.textContent = State.playing ? '⏸' : '▶';
  if (State.playing) {
    const duration = State.session?.duration || 1;
    let last = null;
    function tick(ts) {
      if (!State.playing) return;
      if (last !== null) {
        if (State.currentTime >= duration) { seekTo(0); State.playing = false; btn.textContent = '▶'; return; }
        seekTo(State.currentTime + (ts - last) / 1000);
      }
      last = ts;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────
function zoomAround(frac, factor, duration) {
  duration = duration || State.session?.duration || 1;
  const { xMin, xMax } = State.zoom;
  const span = xMax - xMin;
  const pivot = xMin + frac * span;
  const newSpan = Math.min(duration, Math.max(2, span * factor));
  let lo = pivot - frac * newSpan, hi = lo + newSpan;
  if (lo < 0)        { lo = 0; hi = newSpan; }
  if (hi > duration) { hi = duration; lo = duration - newSpan; }
  applyZoom(lo, hi);
}

function applyZoom(xMin, xMax) {
  State.zoom.xMin = xMin;
  State.zoom.xMax = xMax;
  Object.values(State.charts).forEach(c => {
    if (!c?.options?.scales?.x) return;
    c.options.scales.x.min = xMin;
    c.options.scales.x.max = xMax;
    c.update('none');
  });
  const duration = State.session?.duration || 1;
  const overlay = $('timebar-zoom-overlay');
  if (overlay) {
    overlay.style.left  = (xMin / duration * 100).toFixed(2) + '%';
    overlay.style.right = ((duration - xMax) / duration * 100).toFixed(2) + '%';
  }
}

function resetZoom() {
  const duration = State.session?.duration || 1;
  applyZoom(0, duration);
}

// ─── Timeline Charts ──────────────────────────────────────────────────────────
function ensureTimelineCanvases() {
  const panel = $('panel-timeline');
  if (!panel) return;
  [
    { id: 'chart-stator', label: 'Stator Current (All Motors)' },
    { id: 'chart-supply', label: 'Supply Current (All Motors)' },
    { id: 'chart-temp',   label: 'Motor Temperature' },
  ].forEach(({ id, label }) => {
    if (!$(id)) {
      const card = document.createElement('div');
      card.className = 'chart-card';
      card.innerHTML = `<div class="chart-card-label">${label}</div>
        <div style="position:relative;height:200px"><canvas id="${id}"></canvas></div>`;
      panel.appendChild(card);
    }
  });
  // Live table card
  if (!$('live-table-card')) {
    const card = document.createElement('div');
    card.className = 'chart-card'; card.id = 'live-table-card';
    card.innerHTML = `<div class="chart-card-label">Live Values at Cursor</div>
      <div class="table-wrap">
        <table class="detail-table" id="live-table">
          <thead><tr>
            <th>Motor</th><th>Battery V</th><th>Battery A</th>
            <th>Stator A</th><th>Supply A</th><th>Temp °C</th>
          </tr></thead>
          <tbody id="live-table-body"></tbody>
        </table>
      </div>`;
    panel.appendChild(card);
  }
}

function renderTimelineCharts(data) {
  const tl    = data.timeline || {};
  const times  = tl.time || [];
  if (!times.length) return;

  ['chart-voltage','chart-current','chart-stator','chart-supply','chart-temp'].forEach(id => {
    if (State.charts[id]) { State.charts[id].destroy(); delete State.charts[id]; }
  });

  const segs  = data.match_segments  || [];
  const bouts = data.brownout_events || [];

  if (tl.battery_voltage)
    State.charts['chart-voltage'] = buildTimeChart('chart-voltage', times,
      [{ label: 'Battery Voltage (V)', data: tl.battery_voltage, color: COLORS.voltage }],
      { yLabel: 'Volts', segments: segs, brownouts: bouts,
        yMin: Math.min(...tl.battery_voltage) - 0.5,
        yMax: Math.max(...tl.battery_voltage) + 0.5 });

  if (tl.battery_current)
    State.charts['chart-current'] = buildTimeChart('chart-current', times,
      [{ label: 'Battery Current (A)', data: tl.battery_current, color: COLORS.current }],
      { yLabel: 'Amps', segments: segs, brownouts: bouts });

  if (tl.stator_current_by_motor) {
    const mids = Object.keys(tl.stator_current_by_motor);
    const total = times.map((_, i) => mids.reduce((s,m) => s + Math.abs(tl.stator_current_by_motor[m][i] ?? 0), 0));
    const ds = [{ label: 'Total Stator (A)', data: total, color: COLORS.stator }];
    mids.forEach(mid => {
      const motor = (data.motors||[]).find(m => m.id === mid);
      ds.push({ label: motor?.name ?? mid, data: tl.stator_current_by_motor[mid], color: motor?.color ?? '#888', dashed: true });
    });
    State.charts['chart-stator'] = buildTimeChart('chart-stator', times, ds,
      { yLabel: 'Amps', segments: segs, brownouts: bouts });
  }

  if (tl.supply_current_by_motor) {
    const mids = Object.keys(tl.supply_current_by_motor);
    const total = times.map((_, i) => mids.reduce((s,m) => s + Math.abs(tl.supply_current_by_motor[m][i] ?? 0), 0));
    const ds = [{ label: 'Total Supply (A)', data: total, color: COLORS.supply }];
    mids.forEach(mid => {
      const motor = (data.motors||[]).find(m => m.id === mid);
      ds.push({ label: motor?.name ?? mid, data: tl.supply_current_by_motor[mid], color: motor?.color ?? '#888', dashed: true });
    });
    State.charts['chart-supply'] = buildTimeChart('chart-supply', times, ds,
      { yLabel: 'Amps', segments: segs, brownouts: bouts });
  }

  if (tl.temp_by_motor) {
    const ds = Object.keys(tl.temp_by_motor).map(mid => {
      const motor = (data.motors||[]).find(m => m.id === mid);
      return { label: motor?.name ?? mid, data: tl.temp_by_motor[mid], color: motor?.color ?? '#888' };
    });
    if (ds.length)
      State.charts['chart-temp'] = buildTimeChart('chart-temp', times, ds,
        { yLabel: '°C', segments: segs, brownouts: bouts, yMin: 0 });
  }

  updateLiveTable(0);
}

// ─── Live table ───────────────────────────────────────────────────────────────
function lerp(times, values, t) {
  if (!times?.length || !values?.length) return null;
  if (t <= times[0]) return values[0];
  if (t >= times[times.length-1]) return values[times.length-1];
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) { const mid = (lo+hi)>>1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return values[lo] + (t - times[lo]) / (times[hi] - times[lo]) * (values[hi] - values[lo]);
}

function updateLiveTable(t) {
  const body = $('live-table-body');
  if (!body || !State.session) return;
  const tl     = State.session.timeline || {};
  const times  = tl.time || [];
  const motors = State.session.motors   || [];
  if (!times.length || !motors.length) return;

  const battV = lerp(times, tl.battery_voltage, t);
  const battA = lerp(times, tl.battery_current, t);
  const fmt = (v, d=1) => v != null ? v.toFixed(d) : '–';

  body.innerHTML = motors.map(m => {
    const stator = lerp(times, tl.stator_current_by_motor?.[m.id], t);
    const supply = lerp(times, tl.supply_current_by_motor?.[m.id], t);
    const temp   = lerp(times, tl.temp_by_motor?.[m.id],           t);
    const tCls   = temp != null ? (temp >= 90 ? 'val-crit' : temp >= 70 ? 'val-warn' : '') : '';
    return `<tr>
      <td class="motor-name" style="border-left:3px solid ${m.color};padding-left:10px">${m.name}</td>
      <td>${fmt(battV,2)}</td><td>${fmt(battA)}</td>
      <td>${fmt(stator)}</td><td>${fmt(supply)}</td>
      <td class="${tCls}">${fmt(temp)}</td>
    </tr>`;
  }).join('');
}

// ─── Shared chart builder ─────────────────────────────────────────────────────
function buildTimeChart(canvasId, times, datasets, opts = {}) {
  const ctx = $(canvasId)?.getContext('2d');
  if (!ctx) return null;
  const { yLabel, segments = [], brownouts = [], yMin, yMax } = opts;
  const duration = times[times.length - 1] || 1;
  const { xMin, xMax } = State.zoom;

  const segPlugin = {
    id: 'segBg_' + canvasId,
    beforeDraw({ ctx, chartArea: ca, scales: { x } }) {
      if (!ca) return;
      segments.forEach(seg => {
        ctx.save();
        ctx.fillStyle = seg.type === 'auto' ? 'rgba(245,158,11,0.08)' :
                        seg.type === 'teleop' ? 'rgba(59,130,246,0.08)' : 'rgba(55,65,81,0.12)';
        ctx.fillRect(x.getPixelForValue(seg.start), ca.top, x.getPixelForValue(seg.end) - x.getPixelForValue(seg.start), ca.height);
        ctx.restore();
      });
      brownouts.forEach(ev => {
        ctx.save(); ctx.strokeStyle = 'rgba(239,68,68,0.7)';
        ctx.lineWidth = 1; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(x.getPixelForValue(ev.time), ca.top); ctx.lineTo(x.getPixelForValue(ev.time), ca.bottom); ctx.stroke();
        ctx.restore();
      });
    }
  };

  const cursorPlugin = {
    id: 'cursor_' + canvasId,
    afterDraw({ ctx, chartArea: ca, scales: { x } }) {
      if (!ca) return;
      const xp = x.getPixelForValue(State.currentTime);
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(xp, ca.top); ctx.lineTo(xp, ca.bottom); ctx.stroke();
      ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(xp, ca.top+8, 3, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }
  };

  const chartDatasets = datasets.map(ds => ({
    label: ds.label,
    data: ds.data.map((v, j) => ({ x: times[j], y: v })),
    borderColor: ds.color,
    backgroundColor: ds.dashed ? 'transparent' : hexToRgba(ds.color, 0.08),
    borderWidth: ds.dashed ? 1 : 1.5,
    borderDash: ds.dashed ? [4,4] : [],
    pointRadius: 0, tension: 0.3, fill: !ds.dashed,
  }));

  const chart = new Chart(ctx, {
    type: 'line',
    data: { datasets: chartDatasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1, labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 20 } },
        tooltip: {
          backgroundColor: '#1a1f2e', borderColor: '#2d3748', borderWidth: 1,
          titleColor: '#e2e8f0', bodyColor: '#94a3b8',
          callbacks: { title: items => items[0]?.parsed?.x?.toFixed(2) + 's' }
        }
      },
      scales: {
        x: { type: 'linear', min: xMin, max: xMax,
          grid: { color: 'rgba(45,55,72,0.6)' },
          ticks: { color: '#64748b', font: { size: 10 }, callback: v => v.toFixed(0)+'s', maxTicksLimit: 10 } },
        y: { min: yMin, max: yMax,
          grid: { color: 'rgba(45,55,72,0.6)' },
          ticks: { color: '#64748b', font: { size: 10 } },
          title: { display: !!yLabel, text: yLabel, color: '#64748b', font: { size: 10 } } }
      }
    },
    plugins: [segPlugin, cursorPlugin],
  });

  // Wheel zoom
  $(canvasId)?.addEventListener('wheel', e => {
    e.preventDefault();
    const r = $(canvasId).getBoundingClientRect();
    zoomAround((e.clientX - r.left) / r.width, e.deltaY > 0 ? 1.25 : 0.8);
  }, { passive: false });

  return chart;
}

function updateChartCrosshairs() {
  Object.values(State.charts).forEach(c => c?.update('none'));
}

// ─── Energy Panel ─────────────────────────────────────────────────────────────
function ensureEnergyCanvases() {
  const panel = document.querySelector('[data-panel="energy"]');
  if (!panel) return;
  [
    { id: 'chart-energy-stator-v', label: 'Stator Voltage (Per Motor)' },
    { id: 'chart-energy-supply',   label: 'Supply Current (Per Motor)' },
  ].forEach(({ id, label }) => {
    if (!$(id)) {
      const card = document.createElement('div');
      card.className = 'chart-card';
      card.innerHTML = `<div class="chart-card-label">${label}</div>
        <div style="position:relative;height:220px"><canvas id="${id}"></canvas></div>`;
      panel.appendChild(card);
    }
  });
}

function renderEnergyPanel(data) {
  const energy    = data.energy_by_subsystem || {};
  const bySegment = data.energy_by_segment   || [];
  const tl        = data.timeline            || {};
  const times     = tl.time || [];
  const segs      = data.match_segments  || [];
  const bouts     = data.brownout_events || [];

  const subsystems  = Object.entries(energy);
  const subsysTotal = subsystems.reduce((s,[,v]) => s+v, 0);
  const totalEl = $('total-wh-display');
  if (totalEl) totalEl.textContent = subsysTotal > 0 ? subsysTotal.toFixed(1) : (data.total_energy_wh?.toFixed(1) ?? '–');

  // Donut
  if (subsystems.length && $('chart-energy-donut')) {
    if (State.charts['energy-donut']) State.charts['energy-donut'].destroy();
    const colors = subsystems.map(([k]) => k === 'swerve' ? COLORS.swerve : COLORS.subsystems);
    State.charts['energy-donut'] = new Chart($('chart-energy-donut').getContext('2d'), {
      type: 'doughnut',
      data: { labels: subsystems.map(([k]) => k),
        datasets: [{ data: subsystems.map(([,v]) => v.toFixed(2)), backgroundColor: colors, borderColor: '#1a1f2e', borderWidth: 3 }] },
      options: { responsive: true, maintainAspectRatio: false, cutout: '68%',
        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1a1f2e', borderColor: '#2d3748', borderWidth: 1,
          callbacks: { label: i => `${i.label}: ${i.parsed.toFixed(2)} Wh` } } } }
    });
    $('energy-legend').innerHTML = subsystems.map(([k,v],i) => `
      <div class="energy-leg-item">
        <span class="energy-leg-swatch" style="background:${colors[i]}"></span>
        <span>${k}</span><span class="energy-leg-val">${v.toFixed(2)} Wh</span>
      </div>`).join('');
  }

  // Segment bar
  if (bySegment.length && $('chart-energy-segments')) {
    if (State.charts['energy-seg']) State.charts['energy-seg'].destroy();
    State.charts['energy-seg'] = new Chart($('chart-energy-segments').getContext('2d'), {
      type: 'bar',
      data: { labels: bySegment.map(s => s.label),
        datasets: [{ label: 'Energy (Wh)', data: bySegment.map(s => s.wh.toFixed(2)),
          backgroundColor: bySegment.map(s => hexToRgba(s.type==='auto'?COLORS.auto:s.type==='teleop'?COLORS.teleop:COLORS.disabled, 0.7)),
          borderColor: bySegment.map(s => s.type==='auto'?COLORS.auto:s.type==='teleop'?COLORS.teleop:COLORS.disabled),
          borderWidth: 1, borderRadius: 4 }] },
      options: { responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1a1f2e', borderColor: '#2d3748', borderWidth: 1,
          callbacks: { label: i => `${i.parsed.y} Wh` } } },
        scales: {
          x: { grid: { color: 'rgba(45,55,72,0.6)' }, ticks: { color: '#64748b', font: { size: 10 } } },
          y: { grid: { color: 'rgba(45,55,72,0.6)' }, ticks: { color: '#64748b', font: { size: 10 } },
               title: { display: true, text: 'Wh', color: '#64748b', font: { size: 10 } } } } }
    });
  }

  // Stator voltage timeline
  if (tl.stator_voltage_by_motor && times.length) {
    const activeIds = Object.keys(tl.stator_voltage_by_motor).filter(mid => {
      const arr = tl.stator_voltage_by_motor[mid];
      return arr?.some(v => v != null && Math.abs(v) > 0.01);
    });
    if (activeIds.length) {
      if (State.charts['energy-stator-v']) State.charts['energy-stator-v'].destroy();
      State.charts['energy-stator-v'] = buildTimeChart('chart-energy-stator-v', times,
        activeIds.map(mid => {
          const motor = (data.motors||[]).find(m => m.id === mid);
          return { label: motor?.name ?? mid, data: tl.stator_voltage_by_motor[mid], color: motor?.color ?? '#888' };
        }),
        { yLabel: 'Volts', segments: segs, brownouts: bouts });
    }
  }

  // Supply current timeline
  if (tl.supply_current_by_motor && times.length) {
    const mids = Object.keys(tl.supply_current_by_motor);
    const total = times.map((_, i) => mids.reduce((s,m) => s + Math.abs(tl.supply_current_by_motor[m][i] ?? 0), 0));
    const ds = [{ label: 'Total Supply (A)', data: total, color: COLORS.supply }];
    mids.forEach(mid => {
      const motor = (data.motors||[]).find(m => m.id === mid);
      ds.push({ label: motor?.name ?? mid, data: tl.supply_current_by_motor[mid], color: motor?.color ?? '#888', dashed: true });
    });
    if (State.charts['energy-supply']) State.charts['energy-supply'].destroy();
    State.charts['energy-supply'] = buildTimeChart('chart-energy-supply', times, ds,
      { yLabel: 'Amps', segments: segs, brownouts: bouts });
  }
}

// ─── Heatmap ──────────────────────────────────────────────────────────────────
function renderHeatmap(data) {
  const motors = data.motors || [];
  const container = $('heatmap-container');
  if (!container || !motors.length) return;

  const critTemp = 90, warnTemp = 70;
  function tempColor(t) {
    if (t == null) return '#1e2535';
    const norm = Math.min(1, t / critTemp);
    if (norm < 0.5) {
      const f = norm * 2;
      return `rgb(${Math.round(59+f*(245-59))},${Math.round(130+f*(158-130))},${Math.round(246+f*(11-246))})`;
    }
    const f = (norm-0.5)*2;
    return `rgb(${Math.round(245+f*(239-245))},${Math.round(158+f*(68-158))},${Math.round(11+f*(68-11))})`;
  }

  // Group by subsystem
  const bySubsys = {};
  motors.forEach(m => { if (!bySubsys[m.subsystem]) bySubsys[m.subsystem] = []; bySubsys[m.subsystem].push(m); });

  let html = '';
  for (const [name, mlist] of Object.entries(bySubsys)) {
    const col = mlist[0]?.color ?? '#888';
    html += `<div style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.07em;
                  margin-bottom:8px;border-left:3px solid ${col};padding-left:8px">${name}</div>
      <div class="heatmap-grid">`;
    mlist.forEach(m => {
      const t = m.max_temp, bg = tempColor(t);
      const textCol = t && t > 50 ? '#fff' : '#e2e8f0';
      const cls = t == null ? '' : t >= critTemp ? 'temp-crit' : t >= warnTemp ? 'temp-warn' : '';
      html += `<div class="heat-cell ${cls}" title="${m.name}: max ${t?.toFixed(1)??'N/A'}°C | avg ${m.avg_temp?.toFixed(1)??'N/A'}°C">
        <div class="heat-name">${m.name}</div>
        <div class="heat-temp" style="color:${textCol}">${t != null ? t.toFixed(1)+'°C' : '–'}</div>
        <div class="heat-bar"><div class="heat-bar-fill" style="width:${t?Math.min(100,t/critTemp*100).toFixed(1):0}%;background:${bg}"></div></div>
      </div>`;
    });
    html += `</div></div>`;
  }
  html += `<div class="heatmap-legend"><span>Cool</span><div class="heatmap-gradient"></div><span>Hot (${critTemp}°C+)</span></div>`;
  container.innerHTML = html;
}

// ─── Detail Table ─────────────────────────────────────────────────────────────
function renderDetailTable(data) {
  const motors = data.motors || [];
  const container = $('detail-table-container');
  if (!container || !motors.length) return;
  container.innerHTML = `
    <div class="table-wrap"><table class="detail-table">
      <thead><tr>
        <th>Motor</th><th>Subsystem</th><th>Peak Stator A</th><th>Peak Supply A</th>
        <th>Avg Supply A</th><th>Max Temp °C</th><th>Avg Temp °C</th><th>Energy Wh</th>
      </tr></thead>
      <tbody>${motors.map(m => `<tr>
        <td class="motor-name">${m.name}</td>
        <td><span class="subsys-badge" style="background:${m.color}22;color:${m.color}">${m.subsystem}</span></td>
        <td>${m.peak_stator_current?.toFixed(1) ?? '–'}</td>
        <td>${m.peak_supply_current?.toFixed(1) ?? '–'}</td>
        <td>${m.avg_supply_current?.toFixed(1)  ?? '–'}</td>
        <td class="${m.max_temp >= 90?'val-crit':m.max_temp >= 70?'val-warn':''}">${m.max_temp?.toFixed(1) ?? '–'}</td>
        <td>${m.avg_temp?.toFixed(1)  ?? '–'}</td>
        <td>${m.energy_wh?.toFixed(2) ?? '–'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ─── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  State.activeTab = tab;
  $$('.tab-btn').forEach(b => {
    b.classList.toggle('tab-active',   b.dataset.tab === tab);
    b.classList.toggle('tab-inactive', b.dataset.tab !== tab);
  });
  $$('.tab-panel').forEach(p => { p.style.display = p.dataset.panel === tab ? 'block' : 'none'; });
  setTimeout(() => Object.values(State.charts).forEach(c => c?.resize()), 50);
}

// ─── New session ───────────────────────────────────────────────────────────────
function newSession() {
  State.session = null; State.currentTime = 0; State.playing = false;
  State.zoom = { xMin: 0, xMax: 1 };
  Object.values(State.charts).forEach(c => c?.destroy());
  State.charts = {};
  $('dashboard-panel').style.display = 'none';
  $('upload-panel').style.display    = '';   // let CSS flex rule take over
  $('upload-status').innerHTML = '';
  if ($('file-input')) $('file-input').value = '';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showError(msg) { $('upload-status').innerHTML = `<div class="error-msg">⚠ ${msg}</div>`; }
function showUploadState(_, msg) { $('upload-status').innerHTML = `<div class="info-msg">${msg}</div>`; }

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  initDropZone();
  $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();