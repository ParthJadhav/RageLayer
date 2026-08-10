import { launchChrome, startStaticServer } from "./lib/browser.mjs";

const cpuRate = Number(readFlag("--cpu", "1"));
const durationMs = Number(readFlag("--duration", "4000"));
const warmupMs = Number(readFlag("--warmup", "1000"));
const leakCycles = Math.max(0, Number(readFlag("--leak-cycles", "0")));
const assertBudgets = process.argv.includes("--assert");
const maxEngineP95Ms = Number(readFlag("--max-engine-p95", "25")) * Math.max(1, cpuRate);
const maxHeapGrowthBytes = Number(readFlag("--max-heap-growth", "10000000"));
const maxLayoutMs = Number(readFlag("--max-layout", "50"));
const requestedScenarios = readFlag("--scenarios", "idle,particles,fire,physics,mixed")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

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

function roundValues(value) {
  if (Array.isArray(value)) return value.map(roundValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, roundValues(child)]),
    );
  }
  return typeof value === "number" ? Math.round(value * 100) / 100 : value;
}

function memorySample(metrics) {
  return {
    jsHeapUsedBytes: metrics.JSHeapUsedSize ?? 0,
    nodes: metrics.Nodes ?? 0,
    documents: metrics.Documents ?? 0,
    listeners: metrics.JSEventListeners ?? 0,
    layoutObjects: metrics.LayoutObjects ?? 0,
    arrayBuffers: metrics.ArrayBufferContents ?? 0,
  };
}

const server = await startStaticServer("/benchmarks/runtime.html");
const benchmarkUrl = process.env.DD_BENCHMARK_URL ?? `${server.origin}/benchmarks/runtime.html`;
const browser = await launchChrome({ url: benchmarkUrl, cpuRate });
const { cdp, sessionId, targetId, version } = browser;

try {
  await Promise.all([
    cdp.send("Performance.enable", { timeDomain: "timeTicks" }, sessionId),
    cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false },
      sessionId,
    ),
  ]);

  const evaluate = async (expression) => {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  const deadline = Date.now() + 15_000;
  while (!(await evaluate("document.documentElement.dataset.ready === 'true'"))) {
    if (Date.now() > deadline) throw new Error("Benchmark page did not become ready");
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  const supported = await evaluate("window.ddBenchmark.scenarios");
  const unknown = requestedScenarios.filter((scenario) => !supported.includes(scenario));
  if (unknown.length > 0) throw new Error(`Unknown scenarios: ${unknown.join(", ")}`);

  const results = [];
  for (const scenario of requestedScenarios) {
    await cdp.send("Target.activateTarget", { targetId });
    await cdp.send("Page.bringToFront", {}, sessionId);
    await evaluate(`window.ddBenchmark.setupScenario(${JSON.stringify(scenario)})`);
    await cdp.send("HeapProfiler.collectGarbage", {}, sessionId);
    const before = metricsObject((await cdp.send("Performance.getMetrics", {}, sessionId)).metrics);
    const frame = await evaluate(`window.ddBenchmark.measure(${durationMs}, ${warmupMs})`);
    const after = metricsObject((await cdp.send("Performance.getMetrics", {}, sessionId)).metrics);
    results.push({
      scenario,
      ...frame,
      browser: {
        taskMs: metricDelta(before, after, "TaskDuration"),
        scriptMs: metricDelta(before, after, "ScriptDuration"),
        layoutMs: metricDelta(before, after, "LayoutDuration"),
        recalcStyleMs: metricDelta(before, after, "RecalcStyleDuration"),
        jsHeapUsedBytes: after.JSHeapUsedSize ?? null,
        nodes: after.Nodes ?? null,
      },
    });
  }

  let leak = null;
  if (leakCycles > 0) {
    // Warm all global sprite/shader caches before the baseline so the check
    // measures retained engines rather than deliberate one-time initialization.
    await evaluate("window.ddBenchmark.setupScenario('mixed')");
    await new Promise((resolveWait) => setTimeout(resolveWait, 120));
    const warmDisposeState = await evaluate("window.ddBenchmark.dispose()");
    await cdp.send("HeapProfiler.collectGarbage", {}, sessionId);
    const baseline = memorySample(
      metricsObject((await cdp.send("Performance.getMetrics", {}, sessionId)).metrics),
    );
    const samples = [{ cycles: 0, ...baseline }];
    let completed = 0;
    let disposeState = warmDisposeState;
    while (completed < leakCycles) {
      const count = Math.min(20, leakCycles - completed);
      disposeState = await evaluate(`window.ddBenchmark.cycleScenario('mixed', ${count}, 80)`);
      completed += count;
      await cdp.send("HeapProfiler.collectGarbage", {}, sessionId);
      samples.push({
        cycles: completed,
        ...memorySample(
          metricsObject((await cdp.send("Performance.getMetrics", {}, sessionId)).metrics),
        ),
      });
    }

    const final = samples.at(-1);
    const delta = Object.fromEntries(
      Object.keys(baseline).map((key) => [key, final[key] - baseline[key]]),
    );
    const failures = [];
    if (delta.jsHeapUsedBytes > 1_500_000) {
      failures.push(`JS heap grew by ${delta.jsHeapUsedBytes} bytes`);
    }
    if (delta.nodes > 10) failures.push(`DOM nodes grew by ${delta.nodes}`);
    if (delta.documents > 0) failures.push(`documents grew by ${delta.documents}`);
    if (delta.listeners > 2) failures.push(`event listeners grew by ${delta.listeners}`);
    if (delta.layoutObjects > 4) failures.push(`layout objects grew by ${delta.layoutObjects}`);
    if (
      !disposeState ||
      disposeState.connected ||
      disposeState.containerChildren !== 0 ||
      disposeState.fxWidth !== 0 ||
      disposeState.fxHeight !== 0 ||
      disposeState.flames !== 0 ||
      disposeState.bodies !== 0 ||
      disposeState.particles !== 0 ||
      disposeState.tools !== 0 ||
      disposeState.pageElements !== 0 ||
      disposeState.performanceCallbacks !== 0 ||
      disposeState.contentRoot ||
      disposeState.heatCanvas ||
      disposeState.contentReady ||
      disposeState.debugHandle
    ) {
      failures.push(`disposed engine retained live state: ${JSON.stringify(disposeState)}`);
    }
    leak = { cycles: leakCycles, samples, delta, disposeState, passed: failures.length === 0 };
    if (failures.length > 0) throw new Error(`Memory leak check failed: ${failures.join("; ")}`);
  }

  await evaluate("window.ddBenchmark.dispose()");
  const assertionFailures = [];
  if (assertBudgets) {
    for (const result of results) {
      const cpuP95 = result.engine?.cpu?.p95 ?? 0;
      if (cpuP95 > maxEngineP95Ms) {
        assertionFailures.push(
          `${result.scenario} engine p95 ${cpuP95.toFixed(2)}ms exceeds ${maxEngineP95Ms.toFixed(2)}ms`,
        );
      }
      const heapGrowth = result.heap?.deltaBytes ?? 0;
      if (heapGrowth > maxHeapGrowthBytes) {
        assertionFailures.push(
          `${result.scenario} heap grew ${heapGrowth} bytes (limit ${maxHeapGrowthBytes})`,
        );
      }
      if (result.browser.layoutMs > maxLayoutMs) {
        assertionFailures.push(
          `${result.scenario} layout cost ${result.browser.layoutMs.toFixed(2)}ms exceeds ${maxLayoutMs.toFixed(2)}ms`,
        );
      }
    }
  }
  const output = {
    generatedAt: new Date().toISOString(),
    chrome: version.Browser,
    benchmarkUrl,
    cpuThrottle: cpuRate,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    durationMs,
    warmupMs,
    results,
    leak,
    assertions: assertBudgets
      ? {
          passed: assertionFailures.length === 0,
          limits: { maxEngineP95Ms, maxHeapGrowthBytes, maxLayoutMs },
          failures: assertionFailures,
        }
      : null,
  };
  process.stdout.write(`${JSON.stringify(roundValues(output), null, 2)}\n`);
  if (assertionFailures.length > 0) {
    throw new Error(`Runtime performance budgets failed: ${assertionFailures.join("; ")}`);
  }
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${browser.stderr()}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
  // Node's built-in WebSocket can retain an undici keep-alive handle after a
  // long multi-scenario CDP session. Flush output, then terminate explicitly so
  // the benchmark remains CI-friendly instead of hanging after valid JSON.
  await new Promise((resolveFlushed) => process.stdout.write("", resolveFlushed));
  process.exit(process.exitCode ?? 0);
}
