/**
 * Runtime behaviour suite.
 *
 * The unit tests run on a software Canvas2D with no WebGL, which is the right
 * place to pin destruction logic but cannot see the parts that only exist in a
 * browser: the `foreignObject` page capture, the WebGL2 surface shader, the
 * post-processing chain, real compositing and real teardown. This suite drives
 * the built `dist` through the actual demo page in headless Chrome and asserts
 * what a visitor would see.
 *
 *   node scripts/browser-test.mjs [--only <substring>]
 *
 * `DD_CHROME_PATH` selects the browser. Exits non-zero if any check fails.
 */

import { evaluate, launchChrome, startStaticServer, waitFor } from "./lib/browser.mjs";

const filter = readFlag("--only", "");

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Injected into the demo page once. Tools are driven through real
 * `PointerEvent`s on the engine's own container so the whole input path —
 * pointer capture, primary-pointer gating, coordinate translation — is
 * exercised rather than bypassed.
 */
const HARNESS = `
window.__dd = {
  engine: window.engine,
  frame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  },
  async frames(count) {
    for (let i = 0; i < count; i++) await this.frame();
  },
  event(type, x, y, buttons) {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      // Document coordinates -> viewport coordinates for the event.
      clientX: x - window.scrollX,
      clientY: y - window.scrollY,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      button: 0,
      buttons,
    });
  },
  async use(toolId, path, holdFrames = 6) {
    this.engine.setTool(toolId);
    await this.frame();
    const points = Array.isArray(path[0]) ? path : [path];
    const container = this.engine.container;
    container.dispatchEvent(this.event('pointerdown', points[0][0], points[0][1], 1));
    await this.frames(holdFrames);
    for (let i = 1; i < points.length; i++) {
      container.dispatchEvent(this.event('pointermove', points[i][0], points[i][1], 1));
      await this.frames(holdFrames);
    }
    const last = points[points.length - 1];
    window.dispatchEvent(this.event('pointerup', last[0], last[1], 0));
    await this.frames(2);
  },
  damage(x, y, radius, samples = 20) {
    let gone = 0;
    let total = 0;
    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      for (const scale of [0, 0.4, 0.8, 1]) {
        total++;
        if (this.engine.pageOpacityAt(x + Math.cos(angle) * radius * scale, y + Math.sin(angle) * radius * scale) < 0.3) gone++;
      }
    }
    return gone / total;
  },
  pageDamage(step = 24) {
    let gone = 0;
    let total = 0;
    for (let y = step; y < this.engine.height; y += step) {
      for (let x = step; x < this.engine.width; x += step) {
        total++;
        if (this.engine.pageOpacityAt(x, y) < 0.3) gone++;
      }
    }
    return gone / total;
  },
};
true;
`;

/** Hash a region of the presented page so a change can be detected cheaply. */
function sampleExpression(x, y, width, height) {
  return `(() => {
    const c = __dd.engine.content.surface;
    const ctx = c.getContext('2d');
    const dpr = __dd.engine.content.dpr;
    const data = ctx.getImageData(${x} * dpr, ${y} * dpr, ${width} * dpr, ${height} * dpr).data;
    let hash = 0;
    for (let i = 0; i < data.length; i += 41) hash = (hash * 31 + data[i]) >>> 0;
    return hash;
  })()`;
}

const checks = [
  {
    name: "the live DOM is captured into a destructible surface",
    async run(run) {
      const status = await run("__dd.engine.captureStatus");
      assert(status === "snapshot", `capture status was "${status}", expected "snapshot"`);
      assert(await run("Boolean(__dd.engine.content)"), "no content layer after capture");
      assert(
        await run("__dd.engine.pageOpacityAt(400, 400) === 1"),
        "the freshly captured page is not solid",
      );
    },
  },
  {
    name: "the real DOM is hidden behind the captured copy",
    async run(run) {
      // Snapshot mode hides the page with `visibility` so layout and scrolling
      // survive; hiding it with `display` would collapse the document.
      assert(
        await run("getComputedStyle(document.querySelector('main')).visibility === 'hidden'"),
        "the captured root is still visible under the snapshot",
      );
      assert(
        await run("document.documentElement.scrollHeight > window.innerHeight"),
        "the document collapsed when the page was hidden",
      );
    },
  },
  {
    name: "the WebGL2 surface shader is driving the page",
    async run(run) {
      // This is the whole reason the content canvas is demoted to a texture;
      // if it silently fell back, tears would be flat alpha cutouts.
      assert(await run("__dd.engine.content.shaded"), "surface shading is not active");
      assert(
        await run("__dd.engine.content.canvas instanceof HTMLCanvasElement"),
        "no presented canvas",
      );
    },
  },
  {
    name: "the post-processing chain compiles and runs",
    async run(run) {
      await run("__dd.use('flamethrower', [500, 500], 12)");
      await run("__dd.frames(20)");

      assert(
        await run("__dd.engine.performanceSnapshot.frames > 0"),
        "no frames were rendered under load",
      );
      assert(
        await run("__dd.engine.performanceSnapshot.breakdown.postFXMs >= 0"),
        "post-FX was never measured, so the chain never ran",
      );
      assert(
        await run("['high','balanced','low'].includes(__dd.engine.performanceSnapshot.quality)"),
        "no quality tier reported",
      );
    },
  },
  {
    name: "a gunshot punches a hole clean through the page",
    async run(run) {
      await run("__dd.engine.clear(); __dd.frames(2)");
      await run("__dd.use('gun', [400, 400], 8)");

      assert(await run("__dd.damage(400, 400, 14)"), "the page was not perforated");
    },
  },
  {
    name: "the chainsaw cuts a piece out and it falls",
    async run(run) {
      await run("__dd.engine.clear(); __dd.frames(2)");
      const before = await run("__dd.engine.physics.count");

      await run(
        "__dd.use('chainsaw', [[300, 380], [520, 380], [520, 520], [300, 520], [300, 385]], 4)",
      );
      await run("__dd.frames(40)");

      assert(
        (await run("__dd.engine.physics.count")) > before,
        "cutting a closed loop dropped no piece out of the page",
      );
    },
  },
  {
    name: "undo restores destroyed pixels",
    async run(run) {
      await run("__dd.engine.clear(); __dd.engine.clearHistory(); __dd.frames(2)");
      await run("__dd.use('gun', [600, 400], 8)");
      assert(
        (await run("__dd.damage(600, 400, 14)")) > 0,
        "nothing was destroyed, so undo cannot be tested",
      );

      assert(await run("__dd.engine.undo()"), "undo reported failure");
      await run("__dd.frames(3)");

      assert((await run("__dd.damage(600, 400, 14)")) === 0, "undo left destroyed pixels behind");
    },
  },
  {
    name: "repair returns the whole page to pristine",
    async run(run) {
      const spots = [
        [300, 300],
        [400, 420],
        [500, 500],
      ];
      await run("__dd.use('gun', [[300, 300], [400, 420], [500, 500]], 10)");
      const damaged = await Promise.all(spots.map(([x, y]) => run(`__dd.damage(${x}, ${y}, 16)`)));
      assert(
        damaged.some((value) => value > 0),
        "the page was not damaged",
      );

      await run("__dd.engine.clear()");
      await run("__dd.frames(3)");

      const repaired = await Promise.all(spots.map(([x, y]) => run(`__dd.damage(${x}, ${y}, 16)`)));
      assert(
        repaired.every((value) => value === 0),
        "repair left holes where the page was shot",
      );
      assert((await run("__dd.pageDamage()")) === 0, "repair left holes elsewhere in the page");
    },
  },
  {
    name: "the glitch gun is visible against a white page",
    async run(run) {
      // Regression guard: corruption composited with `screen` was nearly
      // invisible on light sites, which made the tool look broken.
      await run("__dd.engine.clear(); __dd.frames(2)");
      await run(`
        const c = __dd.engine.content;
        const ctx = c.ctx;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.surface.width, c.surface.height);
        ctx.restore();
        c.markSurface(500, 400, 400, true);
      `);
      const before = await run(sampleExpression(400, 340, 200, 120));

      await run("__dd.use('glitch-gun', [500, 400], 20)");

      assert(
        (await run(sampleExpression(400, 340, 200, 120))) !== before,
        "the glitch gun left the white page unchanged",
      );
    },
  },
  {
    name: "a snapshot of the wreckage can be exported",
    async run(run) {
      const size = await run("__dd.engine.snapshot().then((blob) => (blob ? blob.size : 0))");
      assert(size > 1000, `snapshot blob was ${size} bytes`);

      const type = await run("__dd.engine.snapshot('image/jpeg').then((blob) => blob.type)");
      assert(type === "image/jpeg", `snapshot ignored the requested type, produced "${type}"`);
    },
  },
  {
    name: "disposing puts the real page back and leaves nothing behind",
    async run(run) {
      await run("__dd.engine.dispose()");
      await run("__dd.frames(2)");

      assert(
        await run("getComputedStyle(document.querySelector('main')).visibility !== 'hidden'"),
        "the real page was left hidden after dispose",
      );
      assert(
        await run("!document.body.contains(__dd.engine.container)"),
        "the overlay was left in the document",
      );
      assert(
        await run("document.querySelectorAll('canvas').length === 0"),
        "canvases were left behind after dispose",
      );
    },
  },
];

/**
 * Checks against `examples/vanilla`, which builds its toolbar out of
 * `ToolbarModel` and the host's own markup. Nothing else exercises the
 * published headless path, or keyboard aiming, in a real browser.
 */
const exampleChecks = [
  {
    name: "a host-built toolbar renders from the shared model",
    async run(run) {
      await run("document.getElementById('launch').click()");
      await run("new Promise((resolve) => setTimeout(resolve, 1500))");

      const count = await run("document.querySelectorAll('#bar button').length");
      assert(count > 10, `the host toolbar rendered ${count} buttons`);
      assert(
        await run(
          "[...document.querySelectorAll('#bar button')].every((b) => b.getAttribute('aria-label'))",
        ),
        "a toolbar button has no accessible name",
      );
      assert(
        (await run(
          "[...document.querySelectorAll('#bar button')].filter((b) => b.tabIndex === 0).length",
        )) === 1,
        "the roving tabindex does not leave exactly one tab stop",
      );
    },
  },
  {
    name: "the page can be destroyed with the keyboard alone",
    async run(run) {
      const damageAtAim = `(() => {
        const engine = window.__ddExampleEngine;
        const { x, y } = engine.aim;
        let gone = 0;
        for (let i = 0; i < 24; i++) {
          const angle = (i / 24) * Math.PI * 2;
          if (engine.pageOpacityAt(x + Math.cos(angle) * 12, y + Math.sin(angle) * 12) < 0.3) gone++;
        }
        return gone;
      })()`;
      const onPage = `(() => {
        const { x, y } = window.__ddExampleEngine.aim;
        return window.__ddExampleEngine.pageOpacityAt(x, y) === 1;
      })()`;
      const press = (key) =>
        run(
          `window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`,
        );

      // Pick a tool by digit, then enter aiming — no pointer involved at all.
      await press("2");
      await press("a");
      assert(await run("Boolean(window.__ddExampleEngine?.aim)"), "aiming placed no cursor");

      // The example page is short, so the viewport centre can start over the
      // void below the content; walk up until the cursor is on page, exactly
      // as a visitor steering by arrow keys would.
      for (let i = 0; i < 12 && !(await run(onPage)); i++) await press("ArrowUp");
      assert(await run(onPage), "could not steer the cursor onto the page");

      const before = await run(damageAtAim);
      for (let i = 0; i < 8; i++) await press("Enter");
      await run("new Promise((resolve) => setTimeout(resolve, 500))");

      assert((await run(damageAtAim)) > before, "keyboard strikes destroyed nothing");
    },
  },
];

const selected = (list) => list.filter((check) => !filter || check.name.includes(filter));

const server = await startStaticServer("/demo/index.html");
const browser = await launchChrome({
  url: `${server.origin}/demo/index.html`,
  // Software GL: CI runners have no GPU, and the surface shader must still
  // come up there or the fallback would silently become the only tested path.
  flags: ["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader"],
});

// A runtime error the page swallowed is still a defect; surface it as one.
const consoleErrors = [];
browser.cdp.on("Runtime.consoleAPICalled", (params) => {
  if (params.type !== "error") return;
  consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description).join(" "));
});

const run = (expression) => evaluate(browser.cdp, browser.sessionId, expression);

async function runAll(list) {
  let failed = 0;
  for (const check of selected(list)) {
    try {
      await check.run(run);
      console.log(`  ok   ${check.name}`);
    } catch (error) {
      failed++;
      console.error(`  FAIL ${check.name}\n       ${error.message}`);
    }
  }
  return failed;
}

let failures = 0;
try {
  await waitFor(
    browser.cdp,
    browser.sessionId,
    "document.documentElement.dataset.ready === 'true'",
    { label: "the demo page to finish booting" },
  );
  await waitFor(browser.cdp, browser.sessionId, "window.engine && window.engine.content", {
    label: "the page capture to complete",
  });
  await run(HARNESS);

  failures += await runAll(checks);

  // The headless toolbar lives on its own page.
  await run(`location.href = ${JSON.stringify(`${server.origin}/examples/vanilla/index.html`)}`);
  await waitFor(
    browser.cdp,
    browser.sessionId,
    "document.documentElement.dataset.ready === 'true'",
    { label: "the vanilla example to wire up" },
  );

  failures += await runAll(exampleChecks);

  if (consoleErrors.length > 0) {
    failures++;
    console.error("  FAIL the pages logged no console errors");
    for (const error of consoleErrors) console.error(`       ${error}`);
  }
} finally {
  await browser.close();
  await server.close();
}

const total = selected([...checks, ...exampleChecks]).length;
if (failures > 0) {
  console.error(`\n${failures} of ${total} runtime checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${total} runtime checks passed.`);
