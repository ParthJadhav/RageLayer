// Generates the documentation screenshots in docs/screenshots/ by driving the
// demo page with real pointer input through the Chrome DevTools Protocol.
//
//   bun run screenshots            (build + capture)
//   DD_CHROME_PATH=/path/to/chrome node scripts/screenshots.mjs
//
// Every shot loads a fresh demo page, selects a tool, performs a scripted
// gesture and captures a PNG — so the images always reflect the current build.

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(packageRoot, "docs", "screenshots");
const chromePath =
  process.env.DD_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTH = 1280;
const HEIGHT = 800;

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
      const pathname = decodeURIComponent(url.pathname === "/" ? "/demo/index.html" : url.pathname);
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

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const server = await startServer();
const serverAddress = server.address();
const serverPort = typeof serverAddress === "object" && serverAddress ? serverAddress.port : 0;
const debugPort = await freePort();
const profileDir = await mkdtemp(join(tmpdir(), "desktop-destroyer-shots-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    // CI runners (Ubuntu 23.10+) restrict unprivileged user namespaces, which the
    // Chrome sandbox needs; these harnesses only ever load their own local files.
    ...(process.env.CI || process.env.DD_CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
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
    "--enable-unsafe-swiftshader",
    `--window-size=${WIDTH},${HEIGHT}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

let stderr = "";
chrome.stderr.on("data", (chunk) => {
  stderr += chunk;
});

try {
  await mkdir(outputDir, { recursive: true });
  const version = await waitForDebugger(debugPort);
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const cdp = new CdpClient(socket);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await Promise.all([
    cdp.send("Runtime.enable", {}, sessionId),
    cdp.send("Page.enable", {}, sessionId),
    cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false },
      sessionId,
    ),
  ]);

  const evaluate = async (expression) => {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    }
    return result.result.value;
  };

  const mouse = async (type, x, y, held) =>
    cdp.send(
      "Input.dispatchMouseEvent",
      {
        type,
        x,
        y,
        button: "left",
        buttons: held ? 1 : 0,
        clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
        pointerType: "mouse",
      },
      sessionId,
    );

  const click = async (x, y) => {
    await mouse("mousePressed", x, y, true);
    await wait(40);
    await mouse("mouseReleased", x, y, false);
  };

  const drag = async (points, { stepMs = 30, settleMs = 0 } = {}) => {
    const [first, ...rest] = points;
    await mouse("mousePressed", first.x, first.y, true);
    for (const point of rest) {
      await wait(stepMs);
      await mouse("mouseMoved", point.x, point.y, true);
    }
    if (settleMs) await wait(settleMs);
    const last = points[points.length - 1];
    await mouse("mouseReleased", last.x, last.y, false);
  };

  const hold = async (x, y, ms) => {
    await mouse("mousePressed", x, y, true);
    await wait(ms);
  };

  const release = async (x, y) => {
    await mouse("mouseReleased", x, y, false);
  };

  const loadDemo = async () => {
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/` }, sessionId);
    const deadline = Date.now() + 20_000;
    // Optional chaining throughout: between `Page.navigate` returning and the
    // new document existing there is a window where `documentElement` is null
    // and evaluating against it throws rather than simply reporting "not yet".
    while (!(await evaluate("document.documentElement?.dataset.ready === 'true'"))) {
      if (Date.now() > deadline) throw new Error("Demo page did not become ready");
      await wait(100);
    }
    // Wait for the page capture to finish so tools hit real content.
    while ((await evaluate("window.engine?.captureStatus ?? 'capturing'")) === "capturing") {
      if (Date.now() > deadline) throw new Error("Page capture did not finish");
      await wait(100);
    }
    await wait(300);
  };

  const shoot = async (name) => {
    const { data } = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", optimizeForSpeed: false },
      sessionId,
    );
    await writeFile(join(outputDir, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`captured ${name}.png`);
  };

  const selectTool = (id) => evaluate(`window.ddDemo.select(${JSON.stringify(id)})`);

  // ── 1. The pristine demo page with the toolbar ──────────────────────────
  await loadDemo();
  await shoot("demo-page");

  // ── 2. Hammer — escalating blows until regions fracture into debris ─────
  await loadDemo();
  await selectTool("hammer");
  for (const spot of [
    { x: 320, y: 260 },
    { x: 620, y: 300 },
    { x: 900, y: 240 },
  ]) {
    for (let hit = 0; hit < 4; hit++) {
      await click(spot.x + hit * 3, spot.y + hit * 2);
      await wait(120);
    }
  }
  await wait(900);
  await shoot("hammer");

  // ── 3. Gun — full-auto sweep across the hero ────────────────────────────
  await loadDemo();
  await selectTool("gun");
  await drag(
    Array.from({ length: 14 }, (_, i) => ({ x: 240 + i * 60, y: 250 + Math.sin(i / 2) * 40 })),
    { stepMs: 70, settleMs: 200 },
  );
  await wait(600);
  await shoot("gun");

  // ── 4. Flamethrower — captured while the fire is alive and spreading ────
  await loadDemo();
  await selectTool("flamethrower");
  await drag(
    Array.from({ length: 10 }, (_, i) => ({ x: 400 + i * 40, y: 420 })),
    { stepMs: 140, settleMs: 300 },
  );
  await wait(400);
  await shoot("flamethrower");

  // ── 5. Chainsaw — cut a closed loop so the piece drops out whole ────────
  await loadDemo();
  await selectTool("chainsaw");
  const loop = [];
  for (let i = 0; i <= 26; i++) {
    const angle = (i / 26) * Math.PI * 2;
    loop.push({ x: 640 + Math.cos(angle) * 150, y: 330 + Math.sin(angle) * 100 });
  }
  await drag(loop, { stepMs: 50 });
  await wait(1100);
  await shoot("chainsaw");

  // ── 6. Paintball — scattered splats ─────────────────────────────────────
  await loadDemo();
  await selectTool("paintball");
  for (const spot of [
    { x: 300, y: 220 },
    { x: 520, y: 330 },
    { x: 760, y: 240 },
    { x: 940, y: 380 },
    { x: 420, y: 470 },
    { x: 660, y: 520 },
    { x: 860, y: 460 },
  ]) {
    await click(spot.x, spot.y);
    await wait(140);
  }
  await wait(700);
  await shoot("paintball");

  // ── 7. Black hole — captured mid-hold while it lenses the page ──────────
  await loadDemo();
  await selectTool("blackhole");
  await hold(640, 360, 1400);
  await shoot("blackhole");
  await release(640, 360);
  await wait(200);

  // ── 8. Lightning — captured just after the strike ───────────────────────
  await loadDemo();
  await selectTool("lightning");
  await mouse("mousePressed", 700, 320, true);
  await wait(60);
  await mouse("mouseReleased", 700, 320, false);
  await wait(90);
  await shoot("lightning");

  // ── 9. Frost shatter — frozen page breaking as glass, glints in the air ─
  await loadDemo();
  await selectTool("freeze");
  await hold(620, 340, 2000);
  await release(620, 340);
  await wait(150);
  await selectTool("hammer");
  // Work the site up to the breaking blow, then capture immediately so the
  // ice shards and crystalline glints are still in the air.
  for (let hit = 0; hit < 3; hit++) {
    await click(620 + hit * 2, 340 + hit);
    await wait(110);
  }
  await click(626, 344);
  await wait(70);
  await shoot("frost-shatter");

  // ── 10. Water hose — sheeting water putting a fire out ──────────────────
  await loadDemo();
  await selectTool("flamethrower");
  await drag(
    [
      { x: 560, y: 400 },
      { x: 700, y: 400 },
    ],
    { stepMs: 180, settleMs: 400 },
  );
  await selectTool("water");
  await hold(630, 300, 900);
  await shoot("water");
  await release(630, 300);
  await wait(200);

  // ── 11. Broom — sweeping wreckage back to a pristine page ───────────────
  await loadDemo();
  await selectTool("gun");
  await drag(
    Array.from({ length: 12 }, (_, i) => ({ x: 300 + i * 60, y: 320 })),
    { stepMs: 60 },
  );
  await wait(500);
  await selectTool("broom");
  // Stop the sweep half way, so the shot shows repaired page beside damage.
  await drag(
    Array.from({ length: 8 }, (_, i) => ({ x: 300 + i * 45, y: 320 })),
    { stepMs: 90, settleMs: 300 },
  );
  await shoot("broom");

  // ── 12. Rocket launcher — captured on detonation ────────────────────────
  await loadDemo();
  await selectTool("rocket");
  await click(420, 300);
  // Long enough for the motor to carry it clear of the muzzle and arm.
  await wait(700);
  await shoot("rocket");

  // ── 13. Demolition — whole elements knocked loose and falling ───────────
  await loadDemo();
  await selectTool("demolition");
  for (const spot of [
    { x: 360, y: 300 },
    { x: 660, y: 320 },
    { x: 940, y: 300 },
  ]) {
    await click(spot.x, spot.y);
    await wait(220);
  }
  await wait(700);
  await shoot("demolition");

  // ── 14. Bugs — crawling over the surviving page ─────────────────────────
  await loadDemo();
  await selectTool("bugs");
  for (const spot of [
    { x: 380, y: 300 },
    { x: 560, y: 380 },
    { x: 740, y: 300 },
    { x: 900, y: 420 },
  ]) {
    await click(spot.x, spot.y);
    await wait(200);
  }
  await wait(900);
  await shoot("bugs");

  // ── 15. Aftermath — a mixed session with the debris heap ────────────────
  await loadDemo();
  await selectTool("gun");
  await drag(
    Array.from({ length: 10 }, (_, i) => ({ x: 300 + i * 70, y: 230 })),
    { stepMs: 60 },
  );
  await selectTool("hammer");
  for (let hit = 0; hit < 4; hit++) {
    await click(500 + hit * 2, 420);
    await wait(110);
  }
  await selectTool("flamethrower");
  await drag(
    [
      { x: 820, y: 430 },
      { x: 900, y: 430 },
    ],
    { stepMs: 200, settleMs: 500 },
  );
  await selectTool("paintball");
  await click(380, 540);
  await click(720, 560);
  await wait(1600);
  await shoot("aftermath");

  console.log(`\nWrote screenshots to ${outputDir}`);
} catch (error) {
  console.error(stderr.slice(-2000));
  throw error;
} finally {
  chrome.kill("SIGKILL");
  // Wait for the actual exit so Chrome isn't still flushing its profile
  // directory while rm deletes it.
  await Promise.race([
    new Promise((resolveExit) => {
      if (chrome.exitCode != null) resolveExit();
      else chrome.once("exit", resolveExit);
    }),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  await new Promise((resolveClosed) => server.close(resolveClosed));
  await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
