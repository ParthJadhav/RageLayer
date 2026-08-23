/**
 * Shared headless-Chrome plumbing for the repo's browser harnesses.
 *
 * The benchmark, the effect profiler and the runtime test suite all need the
 * same three things: a static server rooted at the package, a Chrome process
 * with the debugging port open, and a small CDP client. Keeping one copy means
 * a fix to the sandbox flags or the shutdown sequence lands everywhere at once.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * Serve the package directory on an ephemeral localhost port.
 *
 * `onRequest(request, response)` runs first and may claim the request by
 * returning true — the hook lets harnesses accept result beacons from
 * browsers they cannot script (e.g. a stock Firefox launched via `open`).
 */
export async function startStaticServer(indexPath = "/demo/index.html", { onRequest } = {}) {
  const server = createServer(async (request, response) => {
    try {
      if (onRequest && (await onRequest(request, response))) return;
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname === "/" ? indexPath : url.pathname);
      const filepath = resolve(packageRoot, `.${pathname}`);
      // Path traversal would let a harness read outside the repo.
      if (!filepath.startsWith(`${packageRoot}/`)) throw new Error("outside package root");
      const info = await stat(filepath);
      if (!info.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(filepath)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      createReadStream(filepath).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
    }
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((closed) => server.close(closed)),
  };
}

export class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        // Naming the method makes a rejected command readable; CDP errors on
        // their own say things like "Invalid parameters" with no context.
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      const callbacks = this.listeners.get(message.method);
      if (!callbacks) return;
      for (const callback of callbacks) callback(message.params ?? {}, message.sessionId);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolveMessage, reject) => {
      this.pending.set(id, { resolve: resolveMessage, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Subscribe to a CDP event by method name. Returns an unsubscribe function. */
  on(method, callback) {
    let callbacks = this.listeners.get(method);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(method, callbacks);
    }
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  }

  /** Resolve on the next occurrence of a CDP event. */
  once(method) {
    return new Promise((resolveEvent) => {
      const off = this.on(method, (params, sessionId) => {
        off();
        resolveEvent({ params, sessionId });
      });
    });
  }
}

async function waitForDebugger(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch {
      // Chrome has not opened the debugging socket yet.
    }
    await new Promise((wait) => setTimeout(wait, 100));
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function freePort() {
  const server = createServer();
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((closed) => server.close(closed));
  return port;
}

export function resolveChromePath() {
  return (
    process.env.RAGELAYER_CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
}

/**
 * Launch headless Chrome and attach to a page target.
 *
 * `chrome-headless-shell` is already headless and rejects `--headless=new`, so
 * the flag is only passed to a full Chrome binary.
 */
export async function launchChrome({ url, flags = [], cpuRate = 1 } = {}) {
  const chromePath = resolveChromePath();
  const isHeadlessShell = /headless[-_]shell/.test(chromePath);
  const debugPort = await freePort();
  const profileDir = await mkdtemp(join(tmpdir(), "ragelayer-"));

  const chrome = spawn(
    chromePath,
    [
      ...(isHeadlessShell ? [] : ["--headless=new"]),
      // CI runners (Ubuntu 23.10+) restrict unprivileged user namespaces, which
      // the Chrome sandbox needs; these harnesses only load their own files.
      ...(process.env.CI || process.env.RAGELAYER_CHROME_NO_SANDBOX
        ? ["--no-sandbox", "--no-zygote"]
        : []),
      ...(String(url).startsWith("file:") ? ["--allow-file-access-from-files"] : []),
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
      "--mute-audio",
      "--enable-precise-memory-info",
      "--metrics-recording-only",
      ...flags,
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
    await new Promise((opened, reject) => {
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const cdp = new CdpClient(socket);
    const { targetId } = await cdp.send("Target.createTarget", { url });
    await cdp.send("Target.activateTarget", { targetId });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    if (cpuRate > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate }, sessionId);

    return {
      cdp,
      sessionId,
      targetId,
      /** DevTools `/json/version` payload; `version.Browser` names the build. */
      version,
      stderr: () => stderr,
      close: () => shutdown(socket, chrome, profileDir),
    };
  } catch (error) {
    chrome.kill();
    await rm(profileDir, { recursive: true, force: true });
    throw new Error(`${error.message}\n${stderr}`);
  }
}

/**
 * Close the socket, stop Chrome, and only then delete its profile directory.
 *
 * Chrome flushes its profile on the way out, so deleting while it is still
 * running loses the race and leaves files behind (or fails outright). Escalate
 * to SIGKILL if it does not go quietly.
 */
async function shutdown(socket, chrome, profileDir) {
  socket.close();
  chrome.kill("SIGTERM");
  await exitedWithin(chrome, 2_000);
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL");
    await exitedWithin(chrome, 2_000);
  }
  await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function exitedWithin(chrome, timeoutMs) {
  if (chrome.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((exited) => chrome.once("exit", exited)),
    new Promise((timedOut) => setTimeout(timedOut, timeoutMs)),
  ]);
}

/** Evaluate an expression in the page and return its value, throwing on error. */
export async function evaluate(cdp, sessionId, expression, { awaitPromise = true } = {}) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(detail.exception?.description ?? detail.text ?? "evaluation failed");
  }
  return result.result.value;
}

/**
 * Block until an expression becomes truthy, or fail with a useful message.
 *
 * The expression is evaluated inside a `try`: between a navigation starting and
 * the new document existing there is a window where `document.documentElement`
 * is null, and a poll that throws there would abort the wait it exists to
 * perform. A throwing expression simply means "not ready yet".
 */
export async function waitFor(cdp, sessionId, expression, { timeoutMs = 20_000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  const guarded = `(() => { try { return Boolean(${expression}); } catch { return false; } })()`;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, sessionId, guarded)) return;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  throw new Error(`Timed out waiting for ${label ?? expression}`);
}
