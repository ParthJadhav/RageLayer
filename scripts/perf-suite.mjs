/**
 * The one-command performance and load-test suite.
 *
 *   bun run build && node scripts/perf-suite.mjs [flags]
 *
 * Drives `benchmarks/stress.html` — scenarios that run many effects
 * simultaneously (fire + fractures + lightning + a black hole + bug swarms +
 * a held tool, all at once) — under headless Chrome via CDP, at one or more
 * CPU throttling rates, and writes per-run artifacts to `artifacts/perf/`:
 *
 *   <scenario>-<cpu>x.cpuprofile     V8 profile (Chrome DevTools / speedscope)
 *   <scenario>-<cpu>x.flamegraph.html self-contained interactive flamegraph
 *   <scenario>-<cpu>x.folded.txt     collapsed stacks for flamegraph.pl tools
 *   <scenario>-<cpu>x.trace.json     Chrome trace (chrome://tracing, Perfetto)
 *   <scenario>-<cpu>x.timeline.json  1 Hz engine snapshot series
 *   timegraph-<cpu>x.html            per-second fps + CPU-breakdown charts
 *   summary.json / SUMMARY.md        aggregated stats, GPU timings, verdicts
 *   run.log                          full per-scenario progress log
 *
 * Flags:
 *   --cpu 1,6         CPU throttle rates to sweep (default "1,6"; 6 ≈ low-end)
 *   --scenarios a,b   subset of stress scenarios (default: all)
 *   --duration 8000   per-scenario ms
 *   --dpr 2           device scale factor
 *   --quality auto    engine quality tier
 *   --capture-mode auto | snapshot | live
 *   --output DIR      artifact directory (default artifacts/perf/<timestamp>)
 *   --metrics-only    skip profiler + tracing (fast smoke run)
 *   --full-trace      include the verbose cc + devtools.timeline categories
 *   --assert          non-zero exit when the 60 fps budget is missed at 1x
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { evaluate, launchChrome, startStaticServer, waitFor } from "./lib/browser.mjs";
import {
  cpuSummary,
  flamegraphHtml,
  foldedStacks,
  frameSummary,
  round,
  sparkline,
  timegraphHtml,
  traceSummary,
} from "./lib/report.mjs";

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const cpuRates = readFlag("--cpu", "1,6")
  .split(",")
  .map((value) => Math.max(1, Number(value.trim())));
const requestedScenarios = readFlag("--scenarios", "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const durationMs = Math.max(2_000, Number(readFlag("--duration", "8000")));
const deviceScaleFactor = Math.max(1, Number(readFlag("--dpr", "2")));
const quality = readFlag("--quality", "auto");
const captureMode = readFlag("--capture-mode", "auto");
const metricsOnly = process.argv.includes("--metrics-only");
const fullTrace = process.argv.includes("--full-trace");
const assertBudgets = process.argv.includes("--assert");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outputDir = resolve(readFlag("--output", join("artifacts", "perf", stamp)));

// 60 fps means a 16.7 ms cadence; p95 ≤ 17.5 ms leaves room for timer jitter
// without letting real jank through. Applied at 1x; throttled runs are
// reported against the same bar so progress toward "low-end at 60" is visible.
const BUDGET = { p95Ms: 17.5, longFrameRate: 0.05 };

const logPath = join(outputDir, "run.log");
async function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  process.stderr.write(`${line}\n`);
  await appendFile(logPath, `${line}\n`);
}

function metricsObject(metrics) {
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

function metricDelta(before, after, key) {
  return ((after[key] ?? 0) - (before[key] ?? 0)) * 1000;
}

function verdictFor(frame) {
  const longRate = frame.over20Ms / Math.max(1, frame.frames);
  const pass = frame.p95Ms <= BUDGET.p95Ms && longRate <= BUDGET.longFrameRate;
  return { pass, longRate };
}

async function runScenario({ cdp, sessionId }, name, cpuRate) {
  await log(`scenario ${name} @ ${cpuRate}x: starting (${durationMs} ms)`);
  const traceEvents = [];
  let offTrace = null;
  let tracingComplete = null;
  if (!metricsOnly) {
    offTrace = cdp.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
    tracingComplete = cdp.once("Tracing.tracingComplete");
    await cdp.send(
      "Tracing.start",
      {
        transferMode: "ReportEvents",
        // `cc` and the full devtools.timeline are enormous (tens of MB per
        // scenario); the trimmed set keeps frame lifecycle + GPU attribution.
        // --full-trace restores everything for deep dives.
        categories: [
          "devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
          "blink.user_timing",
          "gpu",
          ...(fullTrace ? ["disabled-by-default-devtools.timeline", "cc"] : []),
        ].join(","),
      },
      sessionId,
    );
    await cdp.send("Profiler.start", {}, sessionId);
  }

  const before = metricsObject((await cdp.send("Performance.getMetrics", {}, sessionId)).metrics);
  const sample = await evaluate(
    cdp,
    sessionId,
    `window.stress.run(${JSON.stringify(name)}, ${durationMs})`,
  );
  const after = metricsObject((await cdp.send("Performance.getMetrics", {}, sessionId)).metrics);

  let profile = null;
  if (!metricsOnly) {
    ({ profile } = await cdp.send("Profiler.stop", {}, sessionId));
    await cdp.send("Tracing.end", {}, sessionId);
    await tracingComplete;
    offTrace();
  }

  const prefix = `${name}-${cpuRate}x`;
  const artifacts = {};
  if (profile) {
    artifacts.cpuProfile = `${prefix}.cpuprofile`;
    artifacts.flamegraph = `${prefix}.flamegraph.html`;
    artifacts.folded = `${prefix}.folded.txt`;
    artifacts.trace = `${prefix}.trace.json`;
    await Promise.all([
      writeFile(join(outputDir, artifacts.cpuProfile), JSON.stringify(profile)),
      writeFile(join(outputDir, artifacts.flamegraph), flamegraphHtml(profile, prefix)),
      writeFile(join(outputDir, artifacts.folded), foldedStacks(profile)),
      writeFile(join(outputDir, artifacts.trace), JSON.stringify({ traceEvents })),
    ]);
  }
  artifacts.timeline = `${prefix}.timeline.json`;
  await writeFile(
    join(outputDir, artifacts.timeline),
    JSON.stringify({ scenario: name, cpuRate, snapshots: sample.snapshots }, null, 2),
  );

  const frame = frameSummary(sample, 1000 / 60);
  const verdict = verdictFor(frame);
  const result = {
    scenario: name,
    cpuRate,
    frame,
    verdict,
    heap: sample.heap,
    entities: sample.entities,
    engine: sample.engine,
    snapshots: sample.snapshots,
    browser: {
      taskMs: metricDelta(before, after, "TaskDuration"),
      scriptMs: metricDelta(before, after, "ScriptDuration"),
      layoutMs: metricDelta(before, after, "LayoutDuration"),
      recalcStyleMs: metricDelta(before, after, "RecalcStyleDuration"),
    },
    cpu: profile ? cpuSummary(profile) : null,
    trace: profile ? traceSummary(traceEvents) : null,
    artifacts,
  };
  await log(
    `scenario ${name} @ ${cpuRate}x: ${frame.fps.toFixed(1)} fps, ` +
      `p95 ${frame.p95Ms.toFixed(1)} ms, long ${(verdict.longRate * 100).toFixed(1)}%, ` +
      `${verdict.pass ? "PASS" : "MISS"} — particles ${sample.entities.particles}, ` +
      `flames ${sample.entities.flames}, bodies ${sample.entities.bodies}`,
  );
  return result;
}

function markdownSummary(context, results) {
  const lines = [
    "# RageLayer perf suite",
    "",
    `- Generated: ${context.generatedAt}`,
    `- Chrome: ${context.chrome}`,
    `- Duration per scenario: ${durationMs} ms · DPR ${deviceScaleFactor} · quality \`${quality}\` · capture \`${context.captureStatus}\``,
    `- Budget: p95 ≤ ${BUDGET.p95Ms} ms and ≤ ${BUDGET.longFrameRate * 100}% frames over 20 ms`,
    "",
    "| scenario | cpu | fps | p50 | p95 | p99 | max | >20ms | dropped | verdict |",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const result of results) {
    const frame = result.frame;
    lines.push(
      `| ${result.scenario} | ${result.cpuRate}x | ${frame.fps.toFixed(1)} | ` +
        `${frame.p50Ms.toFixed(1)} | ${frame.p95Ms.toFixed(1)} | ${frame.p99Ms.toFixed(1)} | ` +
        `${frame.maxMs.toFixed(0)} | ${((result.verdict.longRate ?? 0) * 100).toFixed(1)}% | ` +
        `${frame.missedFrames} | ${result.verdict.pass ? "✅ pass" : "❌ miss"} |`,
    );
  }
  for (const result of results) {
    const title = `${result.scenario} @ ${result.cpuRate}x`;
    lines.push("", `## ${title}`, "");
    const fpsSeries = result.snapshots.map((snapshot) => snapshot.fps ?? 0);
    if (fpsSeries.length > 1) {
      lines.push(`fps over time: \`${sparkline(fpsSeries, Math.max(60, ...fpsSeries))}\``);
      const cpuSeries = result.snapshots.map((snapshot) => snapshot.cpu?.p95 ?? 0);
      lines.push(`engine cpu p95 (ms): \`${sparkline(cpuSeries)}\``, "");
    }
    if (result.cpu) {
      lines.push("Hottest self time:", "");
      for (const row of result.cpu.topSelf.slice(0, 8)) {
        lines.push(
          `- \`${row.function}\` ${row.file}:${row.line} — self ${row.selfMs.toFixed(1)} ms`,
        );
      }
      lines.push("");
    }
    if (result.trace) {
      lines.push(
        `Threads (busy ms): renderer ${result.trace.rendererMain.totalMs.toFixed(0)}, ` +
          `compositor ${result.trace.compositor.totalMs.toFixed(0)}, ` +
          `gpu ${result.trace.gpu.totalMs.toFixed(0)}`,
      );
      const gpuTop = result.trace.gpu.top.slice(0, 5);
      if (gpuTop.length) {
        lines.push(
          `GPU top: ${gpuTop.map((row) => `${row.name} ${row.totalMs.toFixed(0)}ms`).join(" · ")}`,
        );
      }
      lines.push("");
    }
    const files = Object.values(result.artifacts).map((file) => `\`${file}\``);
    lines.push(`Artifacts: ${files.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- Main ------------------------------------------------------------------
await mkdir(outputDir, { recursive: true });
const server = await startStaticServer("/benchmarks/stress.html");
const targetUrl = `${server.origin}/benchmarks/stress.html`;
await log(`perf suite: ${targetUrl} → ${outputDir}`);

const allResults = [];
let context = null;
let failed = false;

for (const cpuRate of cpuRates) {
  const browser = await launchChrome({ url: targetUrl, cpuRate });
  const { cdp, sessionId, version } = browser;
  try {
    const domains = [
      cdp.send("Performance.enable", { timeDomain: "timeTicks" }, sessionId),
      cdp.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 1280, height: 720, deviceScaleFactor, mobile: false },
        sessionId,
      ),
    ];
    if (!metricsOnly) {
      domains.push(
        cdp.send("Profiler.enable", {}, sessionId),
        cdp.send("Profiler.setSamplingInterval", { interval: 250 }, sessionId),
      );
    }
    await Promise.all(domains);
    await waitFor(cdp, sessionId, 'document.documentElement.dataset.ready === "true"', {
      timeoutMs: 30_000,
      label: "stress fixture",
    });
    const initResult = await evaluate(
      cdp,
      sessionId,
      `window.stress.init(${JSON.stringify({ quality, captureMode })})`,
    );
    await log(`chrome ${version.Browser} @ ${cpuRate}x, capture: ${initResult.captureStatus}`);
    context ??= {
      generatedAt: new Date().toISOString(),
      chrome: version.Browser,
      captureStatus: initResult.captureStatus,
    };

    const scenarioNames = requestedScenarios.length
      ? requestedScenarios
      : await evaluate(cdp, sessionId, "window.stress.scenarios");
    const cpuResults = [];
    for (const name of scenarioNames) {
      try {
        await cdp.send("HeapProfiler.collectGarbage", {}, sessionId);
      } catch {
        // GC assist is best-effort; heap deltas just get noisier without it.
      }
      const result = await runScenario(browser, name, cpuRate);
      cpuResults.push(result);
      allResults.push(result);
      if (assertBudgets && cpuRate === 1 && !result.verdict.pass) failed = true;
      // Settle between scenarios so trailing work does not bleed into the next.
      await evaluate(cdp, sessionId, "window.__rageLayer.clear()");
      await new Promise((wait) => setTimeout(wait, 600));
    }

    const timegraphPath = `timegraph-${cpuRate}x.html`;
    await writeFile(
      join(outputDir, timegraphPath),
      timegraphHtml(
        cpuResults.map((result) => ({
          label: `${result.scenario} @ ${cpuRate}x`,
          snapshots: result.snapshots,
        })),
        `RageLayer perf — ${cpuRate}x CPU throttle`,
      ),
    );
    await log(`timegraph written: ${timegraphPath}`);
  } catch (error) {
    await log(`FAILED @ ${cpuRate}x: ${error.stack ?? error}\n${browser.stderr()}`);
    failed = true;
  } finally {
    await browser.close();
  }
}

await server.close();

const output = round({
  ...context,
  targetUrl,
  cpuRates,
  durationMs,
  deviceScaleFactor,
  quality,
  metricsOnly,
  outputDir,
  budget: BUDGET,
  results: allResults.map(({ snapshots, ...rest }) => ({
    ...rest,
    sampleCount: snapshots.length,
  })),
});
await writeFile(join(outputDir, "summary.json"), JSON.stringify(output, null, 2));
await writeFile(join(outputDir, "SUMMARY.md"), markdownSummary(context ?? {}, allResults));
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
await log(`done — ${allResults.length} runs, summary at ${join(outputDir, "SUMMARY.md")}`);

if (failed) process.exitCode = 1;
// Node's built-in WebSocket can retain an undici keep-alive handle after CDP
// closes; the artifacts are already flushed.
await new Promise((flushed) => process.stdout.write("", flushed));
process.exit(process.exitCode ?? 0);
