// Generates the documentation screenshots in docs/screenshots/ by driving the
// demo page with real pointer input through the Chrome DevTools Protocol.
//
//   bun run screenshots            (build + capture)
//   RAGELAYER_CHROME_PATH=/path/to/chrome node scripts/screenshots.mjs
//
// Every shot loads a fresh demo page, selects a tool, performs a scripted
// gesture and captures a PNG — so the images always reflect the current build.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evaluate as evaluateCdp,
  launchChrome,
  packageRoot,
  startStaticServer,
  waitFor,
} from "./lib/browser.mjs";

const outputDir = join(packageRoot, "docs", "screenshots");
const WIDTH = 1280;
const HEIGHT = 800;

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const server = await startStaticServer("/demo/index.html");
const browser = await launchChrome({
  url: "about:blank",
  flags: ["--enable-unsafe-swiftshader", `--window-size=${WIDTH},${HEIGHT}`],
});
const { cdp, sessionId } = browser;

try {
  await mkdir(outputDir, { recursive: true });
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false },
    sessionId,
  );

  const evaluate = (expression) => evaluateCdp(cdp, sessionId, expression);

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
    await cdp.send("Page.navigate", { url: server.origin }, sessionId);
    await waitFor(cdp, sessionId, "document.documentElement?.dataset.ready === 'true'", {
      label: "the demo page to become ready",
    });
    await waitFor(cdp, sessionId, "window.engine?.captureStatus !== 'capturing'", {
      label: "the page capture to finish",
    });
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

  // The toolbar has a different interaction shape on a phone: one horizontal
  // row, 44 px targets, and a larger persistent guide. Keep a documentation
  // image for that state instead of relying only on geometric assertions.
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
    sessionId,
  );
  // Reload after the mobile override so Chrome applies the meta viewport while
  // constructing the document. Switching an already-loaded desktop page to
  // mobile emulation leaves its old layout viewport cached and produces a
  // misleading cropped screenshot.
  await loadDemo();
  await shoot("demo-mobile");
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false },
    sessionId,
  );

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

  // ── 9. Water hose — sheeting water putting a fire out ───────────────────
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
  // The hose defaults upward, so stage it below the burning strip. This keeps
  // the visible pressure core and the fire it extinguishes on the same line.
  await hold(630, 530, 900);
  await shoot("water");
  await release(630, 530);
  await wait(200);

  // ── 10. Broom — sweeping wreckage back to a pristine page ───────────────
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

  // ── 11. Rocket launcher — captured in flight ────────────────────────────
  await loadDemo();
  await selectTool("rocket");
  await click(420, 300);
  // Long enough for the motor to carry it clear of the muzzle and arm.
  await wait(700);
  await shoot("rocket");

  // ── 12. Demolition — whole elements knocked loose and falling ───────────
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

  // ── 13. Bugs — crawling over the surviving page ─────────────────────────
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

  // ── 14. Aftermath — a mixed session with the debris heap ────────────────
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
  console.error(browser.stderr().slice(-2000));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
