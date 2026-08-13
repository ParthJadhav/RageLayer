import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  evaluate as evaluateCdp,
  launchChrome,
  startStaticServer,
  waitFor,
} from "./lib/browser.mjs";

const requestedTargetUrl = readFlag("--url", null);
const cpuRate = Math.max(1, Number(readFlag("--cpu", "1")));
const deviceScaleFactor = Math.max(1, Number(readFlag("--dpr", "2")));
const durationMs = Math.max(1_500, Number(readFlag("--duration", "5000")));
const variant = readFlag("--variant", "full");
const quality = readFlag("--quality", "high");
const metricsOnly = process.argv.includes("--metrics-only");
const captureScreenshots = process.argv.includes("--screenshots");
const outputDir = resolve(readFlag("--output", join(tmpdir(), `ragelayer-effects-${Date.now()}`)));
const effects = readFlag("--effects", "lightning,paintball,blackhole")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!["high", "balanced", "low", "auto"].includes(quality)) {
  throw new Error(`Unknown quality tier: ${quality}`);
}

const EFFECT_CONFIG = {
  hammer: { mode: "click", intervalMs: 260, activeRatio: 0.8, movePx: 34, moveHz: 0.7 },
  gun: { mode: "hold", intervalMs: 0, activeRatio: 0.8, movePx: 48, moveHz: 0.45 },
  flamethrower: { mode: "hold", intervalMs: 0, activeRatio: 0.8, movePx: 84, moveHz: 0.36 },
  water: { mode: "hold", intervalMs: 0, activeRatio: 0.8, movePx: 92, moveHz: 0.4 },
  chainsaw: { mode: "loop", intervalMs: 0, activeRatio: 0.8, movePx: 150, moveHz: 0.5 },
  paintball: { mode: "hold", intervalMs: 0, activeRatio: 0.8, movePx: 76, moveHz: 0.55 },
  demolition: { mode: "drag", intervalMs: 0, activeRatio: 0.8, movePx: 190, moveHz: 0.34 },
  rocket: { mode: "click", intervalMs: 780, activeRatio: 0.8, movePx: 95, moveHz: 0.33 },
  lightning: { mode: "click", intervalMs: 340, activeRatio: 0.8, movePx: 70, moveHz: 0.4 },
  blackhole: { mode: "hold", intervalMs: 0, activeRatio: 0.8, movePx: 0, moveHz: 0 },
  bugs: { mode: "click", intervalMs: 420, activeRatio: 0.8, movePx: 180, moveHz: 0.27 },
  "gravity-gun": { mode: "hold", intervalMs: 0, activeRatio: 0.8, movePx: 100, moveHz: 0.4 },
  "laser-cutter": { mode: "drag", intervalMs: 0, activeRatio: 0.8, movePx: 150, moveHz: 0.55 },
  "acid-sprayer": { mode: "hold", intervalMs: 0, activeRatio: 0.8, movePx: 90, moveHz: 0.42 },
  "sticky-bombs": { mode: "click", intervalMs: 220, activeRatio: 0.8, movePx: 130, moveHz: 0.35 },
  broom: { mode: "drag", intervalMs: 0, activeRatio: 0.8, movePx: 150, moveHz: 0.62 },
};

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function metricsObject(metrics) {
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

function metricDelta(before, after, key) {
  return ((after[key] ?? 0) - (before[key] ?? 0)) * 1000;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function round(value) {
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, round(child)]));
  }
  return typeof value === "number" ? Math.round(value * 100) / 100 : value;
}

function frameSummary(sample, targetFrameMs) {
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

function cpuSummary(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const rows = new Map();
  const add = (node, key, micros) => {
    const frame = node.callFrame;
    const identity = `${frame.functionName}|${frame.url}|${frame.lineNumber}|${frame.columnNumber}`;
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
    (row) => row.function !== "(idle)" && row.function !== "(program)" && row.function !== "(root)",
  );
  return {
    topSelf: useful
      .slice()
      .sort((a, b) => b.selfMs - a.selfMs)
      .slice(0, 18),
    topTotal: useful
      .slice()
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 18),
  };
}

function traceSummary(events) {
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
    for (const event of events) {
      if (event.ph !== "X" || !event.dur || !keys.has(`${event.pid}:${event.tid}`)) continue;
      durations.set(event.name, (durations.get(event.name) ?? 0) + event.dur / 1000);
    }
    return [...durations.entries()]
      .map(([name, totalMs]) => ({ name, totalMs }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 18);
  };
  const frameSignals = new Map();
  for (const event of events) {
    if (!/(dropped|missed|frame)/i.test(event.name)) continue;
    frameSignals.set(event.name, (frameSignals.get(event.name) ?? 0) + 1);
  }
  return {
    rendererMain: summarizeThread(/CrRendererMain/),
    compositor: summarizeThread(/Compositor/),
    gpuMain: summarizeThread(/CrGpuMain/),
    frameSignals: [...frameSignals.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };
}

const RUN_EFFECT = `
async ({ effect, durationMs, intervalMs, activeRatio, mode, movePx, moveHz, variant }) => {
  const engine = window.__rageLayer;
  if (!engine) throw new Error("ragelayer is not mounted");
  engine.clear();
  if (variant === "no-postfx") {
    engine.opts.postFX = false;
    engine.setPostFXEnabled(false);
  } else if (variant === "no-warp" && engine.contentLayer) {
    engine.contentLayer.setWarp = () => {};
  }
  engine.setTool(effect);
  await new Promise((resolve) => setTimeout(resolve, 220));
  const target = engine.container;
  const centreX = Math.round(innerWidth * 0.56);
  const centreY = Math.round(innerHeight * 0.38);
  let pointerX = centreX;
  let pointerY = centreY;
  const dispatch = (type, buttons, x = pointerX, y = pointerY) => {
    pointerX = x;
    pointerY = y;
    return target.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    clientX: x,
    clientY: y,
    buttons,
    button: type === "pointerup" ? 0 : 0,
    }));
  };
  const intervals = [];
  const longTasks = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  try { observer.observe({ type: "longtask", buffered: false }); } catch {}
  const heapStart = performance.memory?.usedJSHeapSize ?? null;
  const startedAt = performance.now();
  const activeUntil = startedAt + durationMs * activeRatio;
  let previous = startedAt;
  let nextAction = startedAt;
  let held = false;
  if (mode === "hold" || mode === "drag" || mode === "loop") {
    dispatch("pointerdown", 1);
    held = true;
  }
  await new Promise((resolve) => {
    const sample = () => {
      // Use one clock consistently. Under CDP CPU throttling the rAF callback
      // timestamp can trail performance.now() by several seconds, which used
      // to turn a requested six-second scenario into a 20+ second workload and
      // could even record a negative first interval.
      const now = performance.now();
      intervals.push(now - previous);
      previous = now;
      const phase = (now - startedAt) * 0.001 * moveHz * Math.PI * 2;
      const x = centreX + (mode === "loop" ? Math.cos(phase) : Math.sin(phase)) * movePx;
      const y = centreY + (mode === "loop" ? Math.sin(phase) : Math.sin(phase * 0.73)) * movePx * 0.55;
      if (mode === "click" && now < activeUntil && now >= nextAction) {
        dispatch("pointerdown", 1, x, y);
        dispatch("pointerup", 0, x, y);
        nextAction += intervalMs;
      }
      if (held && now < activeUntil && movePx > 0) dispatch("pointermove", 1, x, y);
      if (held && now >= activeUntil) {
        dispatch("pointerup", 0);
        held = false;
      }
      if (now - startedAt >= durationMs) resolve();
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  if (held) dispatch("pointerup", 0);
  observer.disconnect();
  const elapsedMs = performance.now() - startedAt;
  const heapEnd = performance.memory?.usedJSHeapSize ?? null;
  return {
    elapsedMs,
    intervals,
    longTasks: {
      count: longTasks.length,
      totalMs: longTasks.reduce((sum, value) => sum + value, 0),
      maxMs: Math.max(0, ...longTasks),
    },
    heap: heapStart == null ? null : { startBytes: heapStart, endBytes: heapEnd, deltaBytes: heapEnd - heapStart },
    engine: engine.performanceSnapshot,
    entities: {
      ...engine.performanceSnapshot.entities,
    },
  };
}`;

const PREPARE_SCREENSHOT = `
async ({ effect, mode, movePx }) => {
  const engine = window.__rageLayer;
  engine.clear();
  engine.setTool(effect);
  await new Promise((resolve) => setTimeout(resolve, 220));
  const x = Math.round(innerWidth * 0.56);
  const y = Math.round(innerHeight * 0.38);
  const dispatch = (type, buttons, clientX = x, clientY = y) => engine.container.dispatchEvent(new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 7,
    pointerType: "mouse",
    isPrimary: true,
    clientX,
    clientY,
    buttons,
    button: 0,
  }));
  dispatch("pointerdown", 1);
  if (mode === "click") {
    dispatch("pointerup", 0);
    await new Promise((resolve) => setTimeout(resolve, effect === "rocket" ? 700 : 250));
    return;
  }
  const startedAt = performance.now();
  await new Promise((resolve) => {
    const move = () => {
      const now = performance.now();
      const phase = (now - startedAt) * 0.004;
      if (movePx > 0) {
        const px = x + (mode === "loop" ? Math.cos(phase) : Math.sin(phase)) * movePx * 0.45;
        const py = y + (mode === "loop" ? Math.sin(phase) : Math.sin(phase * 0.7)) * movePx * 0.25;
        dispatch("pointermove", 1, px, py);
      }
      if (now - startedAt >= 900) resolve();
      else requestAnimationFrame(move);
    };
    requestAnimationFrame(move);
  });
}`;

await mkdir(outputDir, { recursive: true });
const localServer = requestedTargetUrl ? null : await startStaticServer("/benchmarks/runtime.html");
const targetUrl = requestedTargetUrl ?? `${localServer.origin}/benchmarks/runtime.html`;
const browser = await launchChrome({ url: targetUrl, cpuRate });
const { cdp, sessionId, version } = browser;

try {
  const enableDomains = [
    cdp.send("Page.enable", {}, sessionId),
    cdp.send("Runtime.enable", {}, sessionId),
    cdp.send("Performance.enable", { timeDomain: "timeTicks" }, sessionId),
    cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate }, sessionId),
    cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 720, deviceScaleFactor, mobile: false },
      sessionId,
    ),
  ];
  if (!metricsOnly) {
    enableDomains.push(
      cdp.send("Profiler.enable", {}, sessionId),
      cdp.send("Profiler.setSamplingInterval", { interval: 500 }, sessionId),
    );
  }
  await Promise.all(enableDomains);

  const evaluate = async (expression, argument = undefined) => {
    const result = await cdp.send(
      "Runtime.evaluate",
      {
        expression: `(${expression})(${argument === undefined ? "" : JSON.stringify(argument)})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value;
  };

  const evalValue = (expression) => evaluateCdp(cdp, sessionId, expression);

  await waitFor(
    cdp,
    sessionId,
    `location.href === ${JSON.stringify(targetUrl)} && document.readyState === "complete"`,
    { timeoutMs: 20_000, label: "production page" },
  );
  await evalValue(
    `Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.trim() === "DESTROY")?.click()`,
  );
  await evalValue(
    `if (!window.__rageLayer && window.ddBenchmark) window.ddBenchmark.setupScenario("idle", ${JSON.stringify(
      { quality, toolStyle: "3d" },
    )})`,
  );
  await waitFor(cdp, sessionId, "Boolean(window.__rageLayer)", {
    timeoutMs: Math.max(45_000, 10_000 * cpuRate),
    label: "RageLayer to mount",
  });
  await waitFor(
    cdp,
    sessionId,
    "window.__rageLayer.opts.captureContent === false || ['snapshot', 'live'].includes(window.__rageLayer.captureStatus)",
    { timeoutMs: Math.max(30_000, 20_000 * cpuRate), label: "RageLayer capture" },
  );

  const idle = await evalValue(`new Promise((resolve) => {
    const intervals = [];
    let previous = performance.now();
    const startedAt = previous;
    const sample = () => {
      const now = performance.now();
      intervals.push(now - previous);
      previous = now;
      if (now - startedAt >= 1000) resolve(intervals);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })`);
  const targetFrameMs =
    percentile(
      idle.filter((value) => value > 0 && value < 20),
      0.5,
    ) || 1000 / 60;
  const opacityCheck = await evaluate(`async () => {
    const engine = window.__rageLayer;
    const layer = engine.content;
    if (!layer) return { available: false };
    const x = innerWidth * 0.64 + scrollX;
    const y = innerHeight * 0.42 + scrollY;
    const before = engine.pageOpacityAt(x, y);
    layer.punch(x, y, 20);
    const punched = engine.pageOpacityAt(x, y);
    layer.restore(x, y, 28);
    const restored = engine.pageOpacityAt(x, y);
    layer.punch(x, y, 120);
    const bodiesBeforeVoidActions = engine.physics.count;
    const fractureInVoid = engine.fracture(x, y, 34, { power: 200 });
    const cutoutInVoid = engine.cutout([
      x - 24, y - 24,
      x + 24, y - 24,
      x + 24, y + 24,
      x - 24, y + 24,
    ]);
    const demolitionInVoid = engine.demolish(x, y);
    engine.explode(x, y, 48, { incendiary: false });
    const bodiesAfterVoidActions = engine.physics.count;
    engine.clear();
    return {
      available: true,
      before,
      punched,
      restored,
      fractureInVoid,
      cutoutInVoid,
      demolitionInVoid,
      bodiesCreatedInVoid: bodiesAfterVoidActions - bodiesBeforeVoidActions,
    };
  }`);

  const results = [];
  for (const effect of effects) {
    const config = EFFECT_CONFIG[effect];
    if (!config) throw new Error(`Unknown effect: ${effect}`);
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
          categories: [
            "devtools.timeline",
            "disabled-by-default-devtools.timeline",
            "disabled-by-default-devtools.timeline.frame",
            "blink.user_timing",
            "cc",
            "gpu",
          ].join(","),
        },
        sessionId,
      );
      await cdp.send("Profiler.start", {}, sessionId);
    }
    const before = metricsObject((await cdp.send("Performance.getMetrics", {}, sessionId)).metrics);
    const sample = await evaluate(RUN_EFFECT, { effect, durationMs, variant, ...config });
    const after = metricsObject((await cdp.send("Performance.getMetrics", {}, sessionId)).metrics);
    let profile = null;
    if (!metricsOnly) {
      ({ profile } = await cdp.send("Profiler.stop", {}, sessionId));
      await cdp.send("Tracing.end", {}, sessionId);
      await tracingComplete;
      offTrace();
    }

    let screenshotPath = null;
    if (captureScreenshots) {
      process.stderr.write(`[ragelayer profile] preparing ${effect} screenshot\n`);
      await evaluate(PREPARE_SCREENSHOT, { effect, ...config });
      process.stderr.write(`[ragelayer profile] capturing ${effect} screenshot\n`);
      await cdp.send("Page.bringToFront", {}, sessionId);
      const nextFrame = cdp.once("Page.screencastFrame");
      await cdp.send(
        "Page.startScreencast",
        { format: "png", quality: 100, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
        sessionId,
      );
      const frameEvent = await Promise.race([
        nextFrame,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Chrome screencast timed out")), 5_000),
        ),
      ]);
      await cdp.send(
        "Page.screencastFrameAck",
        { sessionId: frameEvent.params.sessionId },
        sessionId,
      );
      await cdp.send("Page.stopScreencast", {}, sessionId);
      screenshotPath = join(outputDir, `${effect}-${cpuRate}x.png`);
      await writeFile(screenshotPath, Buffer.from(frameEvent.params.data, "base64"));
      process.stderr.write(`[ragelayer profile] wrote ${effect} screenshot\n`);
      await evaluate(`() => {
        const engine = window.__rageLayer;
        engine.container.dispatchEvent(new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 7,
          pointerType: "mouse",
          isPrimary: true,
          buttons: 0,
          button: 0,
        }));
        engine.clear();
      }`);
    }

    const prefix = `${effect}-${cpuRate}x`;
    if (profile) {
      await Promise.all([
        writeFile(join(outputDir, `${prefix}.cpuprofile`), JSON.stringify(profile)),
        writeFile(join(outputDir, `${prefix}.trace.json`), JSON.stringify({ traceEvents })),
      ]);
    }
    results.push({
      effect,
      frame: frameSummary(sample, targetFrameMs),
      heap: sample.heap,
      entities: sample.entities,
      engine: sample.engine,
      browser: {
        taskMs: metricDelta(before, after, "TaskDuration"),
        scriptMs: metricDelta(before, after, "ScriptDuration"),
        layoutMs: metricDelta(before, after, "LayoutDuration"),
        recalcStyleMs: metricDelta(before, after, "RecalcStyleDuration"),
      },
      cpu: profile ? cpuSummary(profile) : null,
      trace: profile ? traceSummary(traceEvents) : null,
      artifacts:
        profile || screenshotPath
          ? {
              ...(profile
                ? {
                    cpuProfile: join(outputDir, `${prefix}.cpuprofile`),
                    trace: join(outputDir, `${prefix}.trace.json`),
                  }
                : {}),
              ...(screenshotPath ? { screenshot: screenshotPath } : {}),
            }
          : null,
    });
    await evalValue("window.__rageLayer.clear()");
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }

  const output = round({
    generatedAt: new Date().toISOString(),
    chrome: version.Browser,
    targetUrl,
    cpuThrottle: cpuRate,
    deviceScaleFactor,
    durationMs,
    variant,
    quality,
    metricsOnly,
    opacityCheck,
    targetFrameMs,
    outputDir,
    results,
  });
  await writeFile(join(outputDir, `summary-${cpuRate}x.json`), JSON.stringify(output, null, 2));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${browser.stderr()}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await localServer?.close();
}

// Node's built-in WebSocket can retain an undici keep-alive handle after CDP
// closes. The report and artifacts are already flushed at this point.
await new Promise((resolveFlushed) => process.stdout.write("", resolveFlushed));
process.exit(process.exitCode ?? 0);
