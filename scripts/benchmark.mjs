import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromePath =
  process.env.DD_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cpuRate = Number(readFlag("--cpu", "1"));
const durationMs = Number(readFlag("--duration", "4000"));
const warmupMs = Number(readFlag("--warmup", "1000"));
const leakCycles = Math.max(0, Number(readFlag("--leak-cycles", "0")));
const requestedScenarios = readFlag("--scenarios", "idle,particles,fire,physics,mixed")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function contentType(pathname) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".css": "text/css; charset=utf-8",
    }[extname(pathname)] ?? "application/octet-stream"
  );
}

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(
        url.pathname === "/" ? "/benchmarks/runtime.html" : url.pathname,
      );
      const filepath = resolve(packageRoot, `.${pathname}`);
      if (!filepath.startsWith(`${packageRoot}/`)) throw new Error("outside package root");
      const info = await stat(filepath);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "Content-Type": contentType(filepath),
        "Cache-Control": "no-store",
      });
      createReadStream(filepath).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
    }
  });
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  return server;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveMessage, reject) => {
      this.pending.set(id, { resolve: resolveMessage, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function waitForDebugger(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch {
      // Chrome has not opened the debugging socket yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClosed) => server.close(resolveClosed));
  return port;
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

const server = await startServer();
const serverAddress = server.address();
const serverPort = typeof serverAddress === "object" && serverAddress ? serverAddress.port : 0;
const debugPort = await freePort();
const profileDir = await mkdtemp(join(tmpdir(), "desktop-destroyer-benchmark-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=Translate,BackForwardCache",
    "--disable-extensions",
    "--disable-sync",
    "--enable-precise-memory-info",
    "--metrics-recording-only",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  const version = await waitForDebugger(debugPort);
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const cdp = new CdpClient(socket);
  const { targetId } = await cdp.send("Target.createTarget", {
    url: `http://127.0.0.1:${serverPort}/benchmarks/runtime.html`,
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await Promise.all([
    cdp.send("Runtime.enable", {}, sessionId),
    cdp.send("Performance.enable", { timeDomain: "timeTicks" }, sessionId),
    cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate }, sessionId),
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
  const output = {
    generatedAt: new Date().toISOString(),
    chrome: version.Browser,
    cpuThrottle: cpuRate,
    viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    durationMs,
    warmupMs,
    results,
    leak,
  };
  process.stdout.write(`${JSON.stringify(roundValues(output), null, 2)}\n`);
  socket.close();
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n${stderr}\n`);
  process.exitCode = 1;
} finally {
  chrome.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => {
      if (chrome.exitCode != null) resolveExit();
      else chrome.once("exit", resolveExit);
    }),
    new Promise((resolveTimeout) =>
      setTimeout(() => {
        chrome.kill("SIGKILL");
        resolveTimeout();
      }, 2_000),
    ),
  ]);
  server.closeAllConnections?.();
  await Promise.race([
    new Promise((resolveClosed) => server.close(resolveClosed)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
  ]);
  await rm(profileDir, { recursive: true, force: true });
  // Node's built-in WebSocket can retain an undici keep-alive handle after a
  // long multi-scenario CDP session. Flush output, then terminate explicitly so
  // the benchmark remains CI-friendly instead of hanging after valid JSON.
  await new Promise((resolveFlushed) => process.stdout.write("", resolveFlushed));
  process.exit(process.exitCode ?? 0);
}
