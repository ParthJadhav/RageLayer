/**
 * Report generation for the perf suite: turns raw CDP artifacts (V8 CPU
 * profiles, Chrome traces, engine snapshot series) into human-readable
 * summaries and self-contained HTML visualisations.
 *
 * Everything emitted here is dependency-free on purpose — the flamegraph and
 * timegraph pages embed their data and renderer inline so they open from a CI
 * artifact download with no network and no tooling.
 */

import { basename } from "node:path";

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

export function round(value) {
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, round(child)]));
  }
  return typeof value === "number" ? Math.round(value * 100) / 100 : value;
}

/** Frame-cadence statistics for one scenario run. */
export function frameSummary(sample, targetFrameMs) {
  const intervals = sample.intervals;
  const missedFrames = intervals.reduce(
    (sum, value) => sum + Math.max(0, Math.round(value / targetFrameMs) - 1),
    0,
  );
  return {
    targetFrameMs,
    frames: intervals.length,
    fps: (intervals.length * 1000) / sample.elapsedMs,
    averageMs: intervals.reduce((sum, value) => sum + value, 0) / Math.max(1, intervals.length),
    p50Ms: percentile(intervals, 0.5),
    p95Ms: percentile(intervals, 0.95),
    p99Ms: percentile(intervals, 0.99),
    maxMs: Math.max(0, ...intervals),
    overBudget: intervals.filter((value) => value > targetFrameMs * 1.5).length,
    over20Ms: intervals.filter((value) => value > 20).length,
    over34Ms: intervals.filter((value) => value > 34).length,
    missedFrames,
    longTasks: sample.longTasks,
  };
}

// ---- CPU profile -----------------------------------------------------------

function profileSelfTimes(profile) {
  const selfMicros = new Map();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const id = profile.samples[i];
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0));
  }
  return selfMicros;
}

/** Hottest functions by self and total time, for the markdown summary. */
export function cpuSummary(profile, limit = 15) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const rows = new Map();
  const add = (node, key, micros) => {
    const frame = node.callFrame;
    const identity = `${frame.functionName}|${frame.url}|${frame.lineNumber}`;
    let row = rows.get(identity);
    if (!row) {
      row = {
        function: frame.functionName || "(anonymous)",
        file: frame.url ? basename(new URL(frame.url).pathname) : "",
        line: frame.lineNumber + 1,
        selfMs: 0,
        totalMs: 0,
      };
      rows.set(identity, row);
    }
    row[key] += micros / 1000;
  };
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const micros = profile.timeDeltas?.[i] ?? 0;
    const sampled = nodes.get(profile.samples[i]);
    if (!sampled) continue;
    add(sampled, "selfMs", micros);
    let current = sampled;
    while (current) {
      add(current, "totalMs", micros);
      current = nodes.get(parents.get(current.id));
    }
  }
  const useful = [...rows.values()].filter(
    (row) => !["(idle)", "(program)", "(root)", "(garbage collector)"].includes(row.function),
  );
  return {
    topSelf: useful
      .slice()
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, limit),
    topTotal: useful
      .slice()
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, limit),
  };
}

/**
 * Collapsed-stack ("folded") text for `flamegraph.pl`-style tooling:
 * one `frame;frame;frame count` line per unique stack, counts in microseconds.
 */
export function foldedStacks(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const label = (node) => {
    const frame = node.callFrame;
    const name = frame.functionName || "(anonymous)";
    const file = frame.url ? basename(new URL(frame.url).pathname) : "";
    return file ? `${name} ${file}:${frame.lineNumber + 1}` : name;
  };
  const lines = new Map();
  for (const [id, micros] of profileSelfTimes(profile)) {
    const stack = [];
    let current = nodes.get(id);
    while (current) {
      stack.unshift(label(current));
      current = nodes.get(parents.get(current.id));
    }
    const key = stack.join(";");
    lines.set(key, (lines.get(key) ?? 0) + micros);
  }
  return [...lines.entries()].map(([stack, micros]) => `${stack} ${micros}`).join("\n");
}

/**
 * Builds the flamegraph tree from a V8 profile: every node carries its self
 * time in ms; totals are the subtree sums. Branches under `minShareOfTotal`
 * collapse into their parent so the embedded JSON stays small.
 */
function flamegraphTree(profile, minShareOfTotal = 0.0005) {
  const selfMicros = profileSelfTimes(profile);
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const build = (id) => {
    const node = nodes.get(id);
    if (!node) return null;
    const frame = node.callFrame;
    const children = (node.children ?? []).map(build).filter(Boolean);
    const self = (selfMicros.get(id) ?? 0) / 1000;
    const total = self + children.reduce((sum, child) => sum + child.total, 0);
    return {
      name: frame.functionName || "(anonymous)",
      file: frame.url ? basename(new URL(frame.url).pathname) : "",
      line: frame.lineNumber + 1,
      self,
      total,
      children: children.sort((a, b) => b.total - a.total),
    };
  };
  const rootId = profile.nodes.find((node) => node.callFrame.functionName === "(root)")?.id;
  const root = build(rootId ?? profile.nodes[0].id);
  const cutoff = root.total * minShareOfTotal;
  const prune = (node) => {
    node.children = node.children.filter((child) => child.total >= cutoff);
    for (const child of node.children) prune(child);
  };
  prune(root);
  return root;
}

/** Self-contained icicle-style flamegraph page for one CPU profile. */
export function flamegraphHtml(profile, title) {
  const tree = flamegraphTree(profile);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — flamegraph</title>
<style>
  body { margin: 0; background: #14161c; color: #e8ecf3;
         font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { padding: 12px 16px; display: flex; gap: 16px; align-items: baseline; }
  h1 { font-size: 15px; margin: 0; }
  #hint { color: #8b96ab; }
  #chart { display: block; width: 100vw; cursor: pointer; }
  #tip { position: fixed; pointer-events: none; background: #21242e; padding: 6px 9px;
         border: 1px solid #3a3f4d; border-radius: 4px; display: none; max-width: 60vw; }
</style>
</head>
<body>
<header><h1>${escapeHtml(title)}</h1><span id="hint">hover for detail · click to zoom · click root to reset</span></header>
<canvas id="chart"></canvas>
<div id="tip"></div>
<script>
const ROOT = ${JSON.stringify(tree)};
const canvas = document.getElementById("chart");
const tip = document.getElementById("tip");
const ctx = canvas.getContext("2d");
const ROW = 18;
let zoomNode = ROOT;
let cells = [];

function depthOf(node) {
  return 1 + node.children.reduce((deep, child) => Math.max(deep, depthOf(child)), 0);
}

function colorFor(name, file) {
  let hash = 0;
  const key = name + file;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  const hue = file ? 8 + (Math.abs(hash) % 40) : 210 + (Math.abs(hash) % 40);
  return "hsl(" + hue + " 62% " + (46 + (Math.abs(hash >> 8) % 14)) + "%)";
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = (depthOf(zoomNode) + 1) * ROW + 8;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = height + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";
  cells = [];
  layout(zoomNode, 0, width, 0);
}

function layout(node, x0, x1, depth) {
  const y = depth * ROW + 4;
  const width = x1 - x0;
  if (width < 0.5) return;
  cells.push({ node, x0, x1, y });
  ctx.fillStyle = colorFor(node.name, node.file);
  ctx.fillRect(x0 + 0.5, y, Math.max(0.5, width - 1), ROW - 2);
  if (width > 34) {
    ctx.fillStyle = "#10131a";
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 + 3, y, width - 6, ROW - 2);
    ctx.clip();
    ctx.fillText(node.name + (node.file ? " " + node.file + ":" + node.line : ""), x0 + 4, y + ROW / 2 - 1);
    ctx.restore();
  }
  let childX = x0;
  for (const child of node.children) {
    const childWidth = (child.total / node.total) * width;
    layout(child, childX, childX + childWidth, depth + 1);
    childX += childWidth;
  }
}

function cellAt(event) {
  const x = event.clientX;
  const y = event.clientY - canvas.getBoundingClientRect().top;
  return cells.find((cell) => x >= cell.x0 && x < cell.x1 && y >= cell.y && y < cell.y + ROW - 2);
}

canvas.addEventListener("mousemove", (event) => {
  const cell = cellAt(event);
  if (!cell) { tip.style.display = "none"; return; }
  const node = cell.node;
  const share = ((node.total / ROOT.total) * 100).toFixed(1);
  tip.innerHTML = "<b>" + node.name + "</b>" + (node.file ? " " + node.file + ":" + node.line : "")
    + "<br>total " + node.total.toFixed(1) + " ms (" + share + "%) · self " + node.self.toFixed(1) + " ms";
  tip.style.display = "block";
  tip.style.left = Math.min(event.clientX + 12, window.innerWidth - 340) + "px";
  tip.style.top = (event.clientY + 14) + "px";
});
canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; });
canvas.addEventListener("click", (event) => {
  const cell = cellAt(event);
  zoomNode = cell && cell.node !== zoomNode ? cell.node : ROOT;
  render();
});
window.addEventListener("resize", render);
render();
</script>
</body>
</html>
`;
}

// ---- Trace / GPU -----------------------------------------------------------

/**
 * Per-thread activity summary from a Chrome trace: renderer main, compositor
 * and the GPU process, plus dropped/missed frame counters. This is where the
 * "is it the CPU or the GPU" question gets answered.
 */
export function traceSummary(events, limit = 15) {
  const threadNames = new Map();
  for (const event of events) {
    if (event.ph === "M" && event.name === "thread_name") {
      threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? "");
    }
  }
  const summarizeThread = (pattern) => {
    const keys = new Set(
      [...threadNames.entries()].filter(([, name]) => pattern.test(name)).map(([key]) => key),
    );
    const durations = new Map();
    let totalMs = 0;
    for (const event of events) {
      if (event.ph !== "X" || !event.dur || !keys.has(`${event.pid}:${event.tid}`)) continue;
      durations.set(event.name, (durations.get(event.name) ?? 0) + event.dur / 1000);
      totalMs += event.dur / 1000;
    }
    return {
      totalMs,
      top: [...durations.entries()]
        .map(([name, ms]) => ({ name, totalMs: ms }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, limit),
    };
  };
  const frameSignals = new Map();
  for (const event of events) {
    if (!/(droppedframe|missedframe|^frame$|beginframe)/i.test(event.name)) continue;
    frameSignals.set(event.name, (frameSignals.get(event.name) ?? 0) + 1);
  }
  return {
    rendererMain: summarizeThread(/CrRendererMain/),
    compositor: summarizeThread(/Compositor$/),
    gpu: summarizeThread(/CrGpuMain|GpuMemory|VizCompositor/),
    frameSignals: [...frameSignals.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  };
}

// ---- Timegraph -------------------------------------------------------------

/**
 * One self-contained page charting each run's per-second engine snapshots:
 * stacked CPU breakdown (update/surface/render/postFX) against the frame
 * budget, with fps and entity counts overlaid.
 */
export function timegraphHtml(runs, title) {
  const data = runs.map((run) => ({
    label: run.label,
    targetFps: run.snapshots.at(-1)?.targetFps ?? 60,
    samples: run.snapshots.map((snapshot) => ({
      fps: snapshot.fps,
      cpuP95: snapshot.cpu?.p95 ?? 0,
      update: snapshot.breakdown?.updateMs ?? 0,
      surface: snapshot.breakdown?.surfaceMs ?? 0,
      render: snapshot.breakdown?.renderMs ?? 0,
      postFX: snapshot.breakdown?.postFXMs ?? 0,
      particles: snapshot.entities?.particles ?? 0,
      flames: snapshot.entities?.flames ?? 0,
      bodies: snapshot.entities?.bodies ?? 0,
      quality: snapshot.quality ?? "",
    })),
  }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)} — timegraph</title>
<style>
  body { margin: 0; padding: 16px; background: #14161c; color: #e8ecf3;
         font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 15px; }
  h2 { font-size: 13px; margin: 22px 0 6px; color: #aeb9cd; }
  canvas { display: block; background: #10131a; border: 1px solid #262c3a; border-radius: 6px; }
  .legend { color: #8b96ab; margin: 4px 0 0; }
  .legend b { font-weight: 600; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="legend">stacked areas: <b style="color:#e8b04c">update</b> ·
<b style="color:#5aa2e8">surface</b> · <b style="color:#67c98b">render</b> ·
<b style="color:#c07ae0">postFX</b> (ms, left axis) — <b style="color:#fff">fps</b> line, right axis;
dashed line marks the frame budget.</p>
<div id="charts"></div>
<script>
const RUNS = ${JSON.stringify(data)};
const HEIGHT = 190;
const COLORS = { update: "#e8b04c", surface: "#5aa2e8", render: "#67c98b", postFX: "#c07ae0" };
const host = document.getElementById("charts");
for (const run of RUNS) {
  const heading = document.createElement("h2");
  heading.textContent = run.label + " — " + run.samples.length + " samples";
  host.append(heading);
  const canvas = document.createElement("canvas");
  host.append(canvas);
  drawRun(canvas, run);
}
function drawRun(canvas, run) {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(480, window.innerWidth - 48);
  canvas.width = width * dpr;
  canvas.height = HEIGHT * dpr;
  canvas.style.width = width + "px";
  canvas.style.height = HEIGHT + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = { left: 42, right: 42, top: 10, bottom: 20 };
  const plotW = width - pad.left - pad.right;
  const plotH = HEIGHT - pad.top - pad.bottom;
  const samples = run.samples;
  if (!samples.length) return;
  const budgetMs = 1000 / (run.targetFps || 60);
  const maxMs = Math.max(budgetMs * 1.4,
    ...samples.map((s) => s.update + s.surface + s.render + s.postFX));
  const maxFps = Math.max(run.targetFps || 60, ...samples.map((s) => s.fps)) * 1.1;
  const x = (i) => pad.left + (samples.length === 1 ? 0 : (i / (samples.length - 1)) * plotW);
  const yMs = (v) => pad.top + plotH - (v / maxMs) * plotH;
  const yFps = (v) => pad.top + plotH - (v / maxFps) * plotH;
  const keys = ["update", "surface", "render", "postFX"];
  let baseline = samples.map(() => 0);
  for (const key of keys) {
    ctx.beginPath();
    samples.forEach((s, i) => ctx.lineTo(x(i), yMs(baseline[i] + s[key])));
    for (let i = samples.length - 1; i >= 0; i--) ctx.lineTo(x(i), yMs(baseline[i]));
    ctx.closePath();
    ctx.fillStyle = COLORS[key] + "cc";
    ctx.fill();
    baseline = baseline.map((v, i) => v + samples[i][key]);
  }
  ctx.strokeStyle = "#d0576a";
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.left, yMs(budgetMs));
  ctx.lineTo(pad.left + plotW, yMs(budgetMs));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  samples.forEach((s, i) => ctx.lineTo(x(i), yFps(s.fps)));
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = "#8b96ab";
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.fillText(maxMs.toFixed(0) + "ms", 4, pad.top + 8);
  ctx.fillText("0", 4, pad.top + plotH);
  ctx.textAlign = "right";
  ctx.fillText(maxFps.toFixed(0) + "fps", width - 4, pad.top + 8);
  ctx.fillText("budget " + budgetMs.toFixed(1) + "ms", width - 4, yMs(budgetMs) - 4);
  ctx.textAlign = "left";
  samples.forEach((s, i) => {
    if (s.quality && (i === 0 || samples[i - 1].quality !== s.quality)) {
      ctx.fillText(s.quality, x(i), HEIGHT - 6);
    }
  });
}
</script>
</body>
</html>
`;
}

/** Compact unicode sparkline for markdown summaries. */
export function sparkline(values, max = Math.max(...values, 1)) {
  const glyphs = "▁▂▃▄▅▆▇█";
  return values
    .map((value) => glyphs[Math.min(glyphs.length - 1, Math.floor((value / max) * glyphs.length))])
    .join("");
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"]/g,
    (match) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[match],
  );
}
