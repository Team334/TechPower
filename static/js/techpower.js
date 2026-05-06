/* TechPower — frontend JS */

let state = null;
let charts = {};
let activeSubsys = "all";
let activeMotorFilter = "all";
let tlChart = null;

// ── API ────────────────────────────────────────────────────────────────────────

async function loadSession(id) {
  toggleSessionMenu();
  showLoading(true);
  try {
    const res = await fetch(`/api/session/${id}`);
    const data = await res.json();
    if (data.error) { alert("Server error: " + data.error); return; }
    applyData(data);
    document.getElementById("sessionBadge").textContent = data.filename || id;
    document.getElementById("sessionBadge").classList.remove("hidden");
  } catch (e) {
    console.error("loadSession failed:", e);
    alert("Failed to load session: " + e);
  } finally {
    showLoading(false);
  }
}

document.getElementById("fileInput").addEventListener("change", async (e) => {
  const files = e.target.files;
  if (!files.length) return;
  showLoading(true);
  const fd = new FormData();
  const chips = document.getElementById("fileChips");
  chips.innerHTML = "";
  for (const f of files) {
    fd.append("logs", f);
    chips.innerHTML += `<span class="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">${f.name}</span>`;
  }
  try {
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    if (data.error) { alert("Server error: " + data.error); return; }
    applyData(data);
    document.getElementById("sessionBadge").classList.add("hidden");
  } catch (err) {
    console.error("Upload failed:", err);
    alert("Upload failed: " + err);
  } finally {
    showLoading(false);
    e.target.value = "";
  }
});

// ── Apply data ────────────────────────────────────────────────────────────────

function applyData(data) {
  state = data;
  updateStats(data);
  buildSummaryCharts(data);
  buildTimeline(data);
  buildMotorDetail(data);
  buildTable(data);
  buildModeBar(data);
}

function updateStats(d) {
  el("statDuration").textContent   = d.duration != null ? fmtDuration(d.duration) : "—";
  el("statSubsystems").textContent = d.subsystems?.length ?? "—";
  el("statEnergy").textContent     = d.total_energy != null ? d.total_energy.toFixed(1) + " Wh" : "—";
  el("statPeak").textContent       = d.peak_power != null ? d.peak_power.toFixed(0) + " W" : "—";
  el("statBrownouts").textContent  = d.brownouts ?? "—";
}

// ── Summary charts ─────────────────────────────────────────────────────────────

function buildSummaryCharts(d) {
  const subs = d.subsystems || [];
  const labels = subs.map(s => s.name);
  const colors = subs.map(s => s.color);

  mkBar("cEnergy", labels, subs.map(s => s.energy_wh.toFixed(2)), colors);
  mkBar("cPeak",   labels, subs.map(s => s.peak_power.toFixed(1)), colors);
  mkBar("cAvg",    labels, subs.map(s => s.avg_power.toFixed(1)),  colors);

  // Per-motor bar
  const allMotors = subs.flatMap(s => s.motors || []);
  mkBar("cMotors",
    allMotors.map(m => m.name),
    allMotors.map(m => m.energy_wh.toFixed(2)),
    allMotors.map(m => {
      const sub = subs.find(s => s.id === m.subsystem);
      return sub ? sub.color : "#64748b";
    })
  );
}

function mkBar(id, labels, data, colors) {
  if (charts[id]) charts[id].destroy();
  const ctx = document.getElementById(id).getContext("2d");
  charts[id] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderRadius: 4, borderSkipped: false }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "#1e293b" } },
        y: { ticks: { color: "#94a3b8", font: { size: 10 } }, grid: { color: "#1e293b" } }
      }
    }
  });
}

// ── Mode bar ─────────────────────────────────────────────────────────────────

function buildModeBar(d) {
  const bar = el("modeBar");
  const ticks = el("brownoutTicks");
  bar.innerHTML = ticks.innerHTML = "";
  if (!d.segments?.length) return;

  const total = d.t_end - d.t_start;
  const modeColors = { auton: "#22c55e", teleop: "#3b82f6", disabled: "#475569" };

  for (const seg of d.segments) {
    const pct = ((seg.end - seg.start) / total * 100).toFixed(2);
    const div = document.createElement("div");
    div.style.cssText = `width:${pct}%;background:${modeColors[seg.mode] || "#475569"};height:100%`;
    div.title = `${seg.mode} ${fmtDuration(seg.start - d.t_start)}–${fmtDuration(seg.end - d.t_start)}`;
    bar.appendChild(div);
  }

  for (const bt of (d.brownout_times || [])) {
    const pct = ((bt - d.t_start) / total * 100).toFixed(2);
    ticks.innerHTML += `<span class="text-xs text-red-400">⚡ ${fmtDuration(bt - d.t_start)}</span>`;
  }
}

// ── Timeline chart ─────────────────────────────────────────────────────────────

function buildTimeline(d) {
  if (!d.timeline) return;
  buildSubsysBtns(d);
  renderTimeline(d, "all");
}

function buildSubsysBtns(d) {
  const cont = el("subsysBtns");
  cont.innerHTML = "";
  for (const sub of (d.subsystems || [])) {
    const btn = document.createElement("button");
    btn.className = "subsys-btn px-3 py-1 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800";
    btn.dataset.id = sub.id;
    btn.textContent = sub.name;
    btn.onclick = () => selectSubsys(sub.id, btn);
    cont.appendChild(btn);
  }
}

function selectSubsys(id, btn) {
  activeSubsys = id;
  document.querySelectorAll(".subsys-btn").forEach(b => {
    b.className = b.dataset.id === id
      ? "subsys-btn px-3 py-1 text-xs rounded border border-blue-700 bg-blue-900 text-blue-200"
      : "subsys-btn px-3 py-1 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800";
  });
  if (state) renderTimeline(state, id);
}

function renderTimeline(d, subsysFilter) {
  const tl = d.timeline;
  const labels = tl.timestamps.map(t => fmtDuration(t - d.t_start));

  let datasets = [];
  const legend = el("tlLegend");
  legend.innerHTML = "";

  if (subsysFilter === "all") {
    // Total battery power
    datasets.push({
      label: "Total",
      data: tl.total_power,
      borderColor: "#e2e8f0",
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.2,
    });
    for (const sub of (d.subsystems || [])) {
      const arr = tl.subsys_power[sub.id];
      if (!arr) continue;
      datasets.push({
        label: sub.name,
        data: arr,
        borderColor: sub.color,
        borderWidth: 1,
        pointRadius: 0,
        fill: true,
        backgroundColor: sub.color + "22",
        tension: 0.2,
      });
      legend.innerHTML += `<span class="flex items-center gap-1 text-xs text-slate-300">
        <span class="inline-block w-3 h-0.5 rounded" style="background:${sub.color}"></span>${sub.name}</span>`;
    }
  } else {
    const sub = (d.subsystems || []).find(s => s.id === subsysFilter);
    if (sub && tl.subsys_power[sub.id]) {
      datasets.push({
        label: sub.name,
        data: tl.subsys_power[sub.id],
        borderColor: sub.color,
        borderWidth: 1.5,
        pointRadius: 0,
        fill: true,
        backgroundColor: sub.color + "33",
        tension: 0.2,
      });
    }
  }

  if (tlChart) tlChart.destroy();
  const ctx = el("cTimeline").getContext("2d");
  tlChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: "index", intersect: false,
          callbacks: {
            title: items => "t = " + items[0].label,
            label: item => ` ${item.dataset.label}: ${item.raw?.toFixed(1)} W`,
          },
          external: (ctx) => updateSnapshot(ctx, d),
        }
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8", maxTicksLimit: 12, font: { size: 10 } },
          grid: { color: "#1e293b" }
        },
        y: {
          ticks: { color: "#94a3b8", font: { size: 10 } },
          grid: { color: "#1e293b" },
          title: { display: true, text: "Watts", color: "#64748b", font: { size: 10 } }
        }
      },
      onClick: (e, elems) => {
        if (elems.length) updateSnapshot({ chart: tlChart, tooltip: tlChart.tooltip }, d);
      }
    }
  });
}

function updateSnapshot(ctx, d) {
  const tooltip = ctx.tooltip || ctx.chart?.tooltip;
  if (!tooltip || !tooltip.dataPoints?.length) return;
  const idx = tooltip.dataPoints[0].dataIndex;
  const t   = d.timeline.timestamps[idx];

  const allMotors = (d.subsystems || []).flatMap(s => s.motors || []);
  const subs      = d.subsystems || [];

  function motorRow(motor) {
    const sub = subs.find(s => s.id === motor.subsystem);
    const color = sub?.color || "#64748b";
    return `<div class="flex justify-between py-0.5">
      <span style="color:${color}">${motor.name}</span>
      <span>{{val}}</span>
    </div>`;
  }

  // Power snapshot — from subsys timeline
  let pHtml = "";
  for (const sub of subs) {
    const val = (d.timeline.subsys_power[sub.id]?.[idx] || 0).toFixed(1);
    pHtml += `<div class="flex justify-between py-0.5">
      <span style="color:${sub.color}">${sub.name}</span><span>${val} W</span></div>`;
  }
  el("snapPower").innerHTML = pHtml || "<span class='text-slate-500'>—</span>";

  // Supply from motor stats (static — no per-time data unless logged)
  let supHtml = "", stHtml = "";
  for (const m of allMotors) {
    const sub = subs.find(s => s.id === m.subsystem);
    const c = sub?.color || "#64748b";
    supHtml += `<div class="flex justify-between py-0.5">
      <span style="color:${c}">${m.name}</span><span>${m.avg_supply.toFixed(2)} A</span></div>`;
  }
  el("snapSupply").innerHTML = supHtml || "<span class='text-slate-500'>—</span>";
  el("hoverLabel").textContent = "t = " + fmtDuration(t - d.t_start);
}

// ── Motor detail ──────────────────────────────────────────────────────────────

function buildMotorDetail(d) {
  const grid = el("motorDetailGrid");
  const fbtns = el("motorFilterBtns");
  grid.innerHTML = fbtns.innerHTML = "";

  const subs = d.subsystems || [];
  for (const sub of subs) {
    const btn = document.createElement("button");
    btn.className = "motor-filter-btn px-3 py-1 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800";
    btn.dataset.filter = sub.id;
    btn.textContent = sub.name;
    btn.onclick = () => filterMotors(sub.id, btn);
    fbtns.appendChild(btn);
  }

  for (const sub of subs) {
    for (const m of (sub.motors || [])) {
      const card = document.createElement("div");
      card.className = "card p-4 motor-card";
      card.dataset.subsys = sub.id;
      card.innerHTML = `
        <div class="flex justify-between mb-2">
          <span class="text-sm font-medium" style="color:${sub.color}">${m.name}</span>
          <span class="text-xs text-slate-400">Ch ${m.channel}</span>
        </div>
        <div class="grid grid-cols-2 gap-y-1 text-xs">
          ${statRow("Energy", m.energy_wh.toFixed(2) + " Wh")}
          ${statRow("Avg power", m.avg_power.toFixed(1) + " W")}
          ${statRow("Peak power", m.peak_power.toFixed(1) + " W")}
          ${statRow("Avg supply", m.avg_supply.toFixed(2) + " A")}
        </div>`;
      grid.appendChild(card);
    }
  }
}

function statRow(label, val) {
  return `<span class="text-slate-400">${label}</span><span class="text-right">${val}</span>`;
}

function filterMotors(filter, btn) {
  activeMotorFilter = filter;
  document.querySelectorAll(".motor-filter-btn").forEach(b => {
    b.className = b.dataset.filter === filter
      ? "motor-filter-btn px-3 py-1 text-xs rounded border border-blue-700 bg-blue-900 text-blue-200"
      : "motor-filter-btn px-3 py-1 text-xs rounded border border-slate-600 text-slate-300 hover:bg-slate-800";
  });
  document.querySelectorAll(".motor-card").forEach(card => {
    card.style.display = (filter === "all" || card.dataset.subsys === filter) ? "" : "none";
  });
}

// ── Data table ────────────────────────────────────────────────────────────────

function buildTable(d) {
  const tbody = el("tableBody");
  tbody.innerHTML = "";
  const subs = d.subsystems || [];
  for (const sub of subs) {
    for (const m of (sub.motors || [])) {
      const tr = document.createElement("tr");
      tr.className = "border-b border-slate-800 hover:bg-slate-800 transition-colors";
      tr.innerHTML = `
        <td class="p-3 font-medium" style="color:${sub.color}">${m.name}</td>
        <td class="p-3 text-slate-300">${sub.name}</td>
        <td class="p-3 text-right">${m.energy_wh.toFixed(2)}</td>
        <td class="p-3 text-right">${m.avg_power.toFixed(1)}</td>
        <td class="p-3 text-right">${m.peak_power.toFixed(1)}</td>
        <td class="p-3 text-right">${m.avg_supply.toFixed(2)}</td>`
      tbody.appendChild(tr);
    }
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function switchTab(name, btn) {
  ["summary", "timeline", "motors", "table"].forEach(t => {
    el("tab-" + t).classList.add("hidden");
  });
  el("tab-" + name).classList.remove("hidden");
  document.querySelectorAll("[onclick^='switchTab']").forEach(b => {
    b.className = "tab-inactive px-4 py-2 text-sm font-medium";
  });
  btn.className = "tab-active px-4 py-2 text-sm font-medium";

  // Trigger chart resize after unhide
  setTimeout(() => {
    Object.values(charts).forEach(c => c?.resize?.());
    tlChart?.resize?.();
  }, 50);
}

// ── Session dropdown ───────────────────────────────────────────────────────────

function toggleSessionMenu() {
  el("sessionMenu").classList.toggle("hidden");
}
document.addEventListener("click", e => {
  if (!el("sessionDropdown").contains(e.target)) {
    el("sessionMenu").classList.add("hidden");
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }
function showLoading(on) { el("loadingOverlay").classList.toggle("hidden", !on); }

function fmtDuration(s) {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}