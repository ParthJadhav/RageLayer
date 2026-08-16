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
 *   node scripts/browser-test.mjs [--only <substring>] [--cpu <rate>]
 *
 * `RAGELAYER_CHROME_PATH` selects the browser. Exits non-zero if any check fails.
 */

import { evaluate, launchChrome, startStaticServer, waitFor } from "./lib/browser.mjs";

const filter = readFlag("--only", "");

/**
 * Rasterizing a cold page is the slowest thing this suite does, and it is the
 * one wait whose budget has to survive a loaded shared runner. Generous on
 * purpose: a timeout here should mean the capture is broken, not that the
 * machine was busy.
 */
const CAPTURE_TIMEOUT_MS = 60_000;

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Poll a page-side expression until it is true. The equivalent of `waitFor`
 * from lib/browser.mjs for checks that only receive `run`. Failing here as a
 * timeout rather than as a wrong value keeps a slow machine distinguishable
 * from a broken one.
 */
async function until(run, expression, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
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
    name: "the demo starts with every tool on the bar",
    async run(run) {
      const result = await run(`(() => ({
        toolButtons: document.querySelectorAll('#rl-bar button[aria-pressed]').length,
        registered: __dd.engine.getTools().length,
        pickers: document.querySelectorAll('#rl-bar select').length,
        guide: document.querySelector('#rl-guide')?.textContent ?? '',
      }))()`);

      assert(result.toolButtons === 16, `the first run exposed ${result.toolButtons} tools`);
      assert(
        result.registered === result.toolButtons,
        `${result.registered} tools are registered but ${result.toolButtons} have buttons`,
      );
      assert(result.pickers === 0, "the toolbar still hides tools behind a picker");
      assert(result.guide.includes("Pick a tool"), "the initial guide did not invite a choice");
      assert(result.guide.includes("all 16"), "the initial guide did not explain its scope");
    },
  },
  {
    name: "a settled selected tool lets the engine frame loop sleep",
    async run(run) {
      const result = await run(`(async () => {
        __dd.engine.clear();
        __dd.engine.setTool('hammer');
        __dd.engine.container.dispatchEvent(new PointerEvent('pointermove', {
          clientX: 320,
          clientY: 320,
          pointerId: 1,
          isPrimary: true,
        }));
        let engineFrames = 0;
        const original = __dd.engine.frame;
        __dd.engine.frame = (now) => {
          engineFrames++;
          return original(now);
        };
        // Wait for the loop to genuinely sleep rather than draining for a
        // fixed 250ms. The frame that clear/setTool/the first move requested
        // captured the pre-patch engine.frame when it was scheduled; on a slow
        // machine it can still be pending after any fixed budget, and the
        // second move then coalesces into that callback — the engine presents
        // the move correctly, but the counter never sees it and this check
        // reports a wedge that does not exist. No scheduled frame and a parked
        // frame clock mean the next wake must schedule the patched frame.
        const settleDeadline = performance.now() + 10000;
        while (
          (__dd.engine.raf !== 0 || !__dd.engine.frameClockSleeping) &&
          performance.now() < settleDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        if (__dd.engine.raf !== 0 || !__dd.engine.frameClockSleeping) {
          return { settled: false };
        }
        const beforeMove = engineFrames;
        __dd.engine.container.dispatchEvent(new PointerEvent('pointermove', {
          clientX: 420,
          clientY: 320,
          pointerId: 1,
          isPrimary: true,
        }));
        // Wait for the redraw the move should request instead of assuming it
        // lands inside a fixed budget: the claim is that a move schedules a
        // frame, not that a loaded machine services it within 80ms.
        const moveDeadline = performance.now() + 2000;
        while (engineFrames === beforeMove && performance.now() < moveDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 16));
        }
        const moveFrames = engineFrames - beforeMove;
        const settledAt = engineFrames;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          settled: true,
          moveFrames,
          idleFrames: engineFrames - settledAt,
          pointerX: __dd.engine.pointer.x,
          visibility: document.visibilityState,
          paused: __dd.engine.paused,
        };
      })()`);

      assert(result.settled, "the frame loop never slept after clear and tool selection");
      assert(result.pointerX === 420, "the on-demand pointer update was lost");
      assert(
        result.moveFrames >= 1,
        `pointer movement did not request a tool-art frame (visibility ${result.visibility}, paused ${result.paused})`,
      );
      assert(
        result.idleFrames <= 1,
        `the visible idle tool still rendered ${result.idleFrames} frames in 300ms`,
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

      const loop = await run(`(() => {
        const panel = document.querySelector('.card[style]');
        const rect = panel.getBoundingClientRect();
        const x0 = rect.left + window.scrollX + 36;
        const y0 = rect.top + window.scrollY + 36;
        const x1 = Math.min(rect.right + window.scrollX - 36, x0 + 240);
        const y1 = Math.min(rect.bottom + window.scrollY - 36, y0 + 100);
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 5]];
      })()`);

      await run(`__dd.use('chainsaw', ${JSON.stringify(loop)}, 4)`);
      await run("__dd.frames(40)");

      assert(
        (await run("__dd.engine.physics.count")) > before,
        "cutting a closed loop dropped no piece out of the page",
      );
    },
  },
  {
    name: "the laser leaves one continuous constant-width kerf",
    async run(run) {
      await run("__dd.engine.clear(); __dd.frames(2)");
      await run("__dd.use('laser-cutter', [[240, 340], [680, 340]], 2)");

      const result = await run(`(() => {
          const gaps = [];
          const tooWide = [];
          for (let x = 242; x <= 678; x += 4) {
            const center = __dd.engine.pageOpacityAt(x, 340);
            const outside = __dd.engine.pageOpacityAt(x, 348);
            if (center >= 0.3) gaps.push([x, center]);
            if (outside < 0.9) tooWide.push([x, outside]);
          }
          return { gaps, tooWide };
        })()`);
      assert(
        result.gaps.length === 0 && result.tooWide.length === 0,
        `the laser path was not a clean kerf: ${result.gaps.length} gaps (${JSON.stringify(result.gaps.slice(0, 4))}), ${result.tooWide.length} wide samples (${JSON.stringify(result.tooWide.slice(0, 4))})`,
      );
    },
  },
  {
    name: "the toolbar explains tools without unnecessary desktop wrapping",
    async run(run, { resize }) {
      const original = await run("({ width: innerWidth, height: innerHeight })");
      try {
        await resize(1440, 900);
        const result = await run(`(() => {
          const bar = document.querySelector('#rl-bar');
          const guide = document.querySelector('#rl-guide');
          const name = document.querySelector('#rl-name');
          const laser = document.querySelector('button[aria-label="Laser Cutter"]');
          laser.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
          return {
            barHeight: bar.getBoundingClientRect().height,
            guide: guide.textContent,
            brandVisible: name.textContent.includes('RageLayer') && name.getBoundingClientRect().width > 0,
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          };
        })()`);
        assert(result.guide.includes("Laser Cutter"), "hovering a tool did not explain it");
        assert(result.guide.includes("clean cut"), "the laser hint does not describe its gesture");
        assert(result.brandVisible, "the toolbar has no visible RageLayer identity");
        assert(result.barHeight <= 70, `the desktop toolbar grew to ${result.barHeight}px tall`);
        assert(!result.overflow, "the toolbar introduced horizontal page overflow");
      } finally {
        await resize(original.width, original.height);
      }
    },
  },
  {
    name: "the toolbar stays understandable and touchable on a phone viewport",
    async run(run, { resize }) {
      const original = await run("({ width: innerWidth, height: innerHeight })");
      try {
        await resize(375, 667);
        await run(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );

        const result = await run(`(async () => {
          const bar = document.querySelector('#rl-bar');
          const guide = document.querySelector('#rl-guide');
          const meta = document.querySelector('#rl-meta');
          const name = document.querySelector('#rl-name');
          const laser = document.querySelector('button[aria-label="Laser Cutter"]');
          laser.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            pointerType: 'touch',
          }));
          const touchGuide = guide.textContent;
          const controls = [...bar.querySelectorAll('button, select')];
          const last = controls.at(-1);
          last.focus();
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const barRect = bar.getBoundingClientRect();
          const lastRect = last.getBoundingClientRect();
          return {
            overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            barInsideViewport: barRect.left >= 0 && barRect.right <= innerWidth,
            scrollable: bar.scrollWidth > bar.clientWidth,
            lastControlVisible: lastRect.left >= barRect.left && lastRect.right <= barRect.right,
            minControlWidth: Math.min(...controls.map((control) => control.getBoundingClientRect().width)),
            minControlHeight: Math.min(...controls.map((control) => control.getBoundingClientRect().height)),
            guideFontSize: Number.parseFloat(getComputedStyle(guide).fontSize),
            brandVisible: name.textContent.includes('RageLayer') && name.getBoundingClientRect().width > 0,
            metaInsideViewport: meta.getBoundingClientRect().left >= 0 && meta.getBoundingClientRect().right <= innerWidth,
            touchGuide,
          };
        })()`);

        assert(!result.overflow, "the mobile toolbar widened the document");
        assert(result.barInsideViewport, "the mobile toolbar escaped the viewport");
        assert(result.scrollable, "the full toolset did not become a horizontally scrollable row");
        assert(result.lastControlVisible, "keyboard focus did not reveal an off-screen control");
        assert(result.minControlWidth >= 44, `a control was only ${result.minControlWidth}px wide`);
        assert(
          result.minControlHeight >= 44,
          `a control was only ${result.minControlHeight}px tall`,
        );
        assert(result.guideFontSize >= 14, `the mobile tool guide was ${result.guideFontSize}px`);
        assert(result.brandVisible, "the mobile toolbar has no visible RageLayer identity");
        assert(result.metaInsideViewport, "the RageLayer controls escaped the phone viewport");
        assert(
          result.touchGuide.includes("Laser Cutter"),
          "touch did not reveal the selected tool name",
        );
        assert(result.touchGuide.includes("clean cut"), "touch did not reveal the laser gesture");
      } finally {
        await resize(original.width, original.height);
        // Restoring the viewport can invalidate snapshot geometry and schedule
        // an asynchronous recapture. Do not let the next destructive scenario
        // fire into that transition.
        await run("new Promise((resolve) => setTimeout(resolve, 600))");
        await run("__dd.frames(3)");
      }
    },
  },
  {
    name: "the runtime exposes one fixed wood surface and no removed tools",
    async run(run) {
      const result = await run(`(() => {
        const labels = [...document.querySelectorAll('#rl-bar button')]
          .map((button) => button.getAttribute('aria-label'));
        return {
          materialAttributes: document.querySelectorAll('[data-ragelayer-material]').length,
          hasMaterialsRegistry: 'materials' in __dd.engine,
          hasMaterialLookup: typeof __dd.engine.materialAt === 'function',
          removedTools: ['Freeze ray', 'Wrecking ball', 'Glitch gun'].filter((name) => labels.includes(name)),
        };
      })()`);

      assert(result.materialAttributes === 0, "the demo still declares material regions");
      assert(!result.hasMaterialsRegistry, "the public material registry still exists");
      assert(!result.hasMaterialLookup, "the public material lookup still exists");
      assert(result.removedTools.length === 0, `removed tools remain: ${result.removedTools}`);
    },
  },
  {
    name: "undo restores destroyed pixels",
    async run(run) {
      await run("__dd.engine.clear(); __dd.engine.clearHistory(); __dd.frames(2)");
      await run("__dd.use('gun', [400, 400], 8)");
      assert(
        (await run("__dd.damage(400, 400, 14)")) > 0,
        "nothing was destroyed, so undo cannot be tested",
      );

      assert(await run("__dd.engine.undo()"), "undo reported failure");
      await run("__dd.frames(3)");

      assert((await run("__dd.damage(400, 400, 14)")) === 0, "undo left destroyed pixels behind");
    },
  },
  {
    name: "repair returns the whole page to pristine",
    async run(run) {
      await run("__dd.engine.clear(); __dd.frames(2)");
      const pristineDamage = await run("__dd.pageDamage()");
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
      assert(
        Math.abs((await run("__dd.pageDamage()")) - pristineDamage) < 0.0001,
        "repair did not return the page to its pristine coverage",
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
      // Opening rasterizes the page before the engine — and therefore the
      // toolbar — exists. That takes as long as the machine takes, so wait for
      // the bar rather than for a duration; a fixed sleep is a coin flip on a
      // shared CI runner and reports "0 buttons" when it loses.
      await until(
        run,
        "document.querySelectorAll('#bar button').length > 0",
        "the host toolbar to render",
        CAPTURE_TIMEOUT_MS,
      );

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

      // Independent of whether the check above already opened the engine.
      await until(
        run,
        "Boolean(window.__ddExampleEngine)",
        "the example engine to mount",
        CAPTURE_TIMEOUT_MS,
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

/** The framework-neutral ready-made toolbar, exercised through its shadow DOM. */
const customElementChecks = [
  {
    name: "the custom element keeps shared toolbar behavior in a real browser",
    async run(run) {
      await run(`import('/dist/element/index.js').then(() => {
        window.__ddExampleEngine?.dispose();
        const element = document.createElement('rage-layer');
        element.configure({ captureContent: false, history: true });
        document.body.append(element);
        window.__ddElement = element;
      })`);

      const result = await run(`(() => {
        const root = window.__ddElement.shadowRoot;
        const toolbar = root.querySelector('[role="toolbar"]');
        const hammer = root.querySelector('button[aria-label="Hammer"]');
        hammer.focus();
        hammer.click();
        root.querySelector('button[aria-label="Aim the tool with the arrow keys"]').click();
        return {
          label: toolbar.getAttribute('aria-label'),
          buttonCount: toolbar.querySelectorAll('button').length,
          focus: root.activeElement?.getAttribute('aria-label'),
          aiming: Boolean(window.__ddElement.rageLayerEngine.aim),
        };
      })()`);

      assert(result.label === "RageLayer tools", `toolbar label was "${result.label}"`);
      assert(
        result.buttonCount > 20,
        `the ready-made toolbar rendered ${result.buttonCount} buttons`,
      );
      assert(result.focus === "Hammer", `selection lost focus to "${result.focus}"`);
      assert(result.aiming, "the shared aim action did not reach the engine");
    },
  },
  {
    name: "the custom element exposes touch guidance and 44px mobile controls",
    async run(run, { resize }) {
      const original = await run("({ width: innerWidth, height: innerHeight })");
      try {
        await resize(375, 667);
        const result = await run(`(() => {
          const root = window.__ddElement.shadowRoot;
          const toolbar = root.querySelector('[role="toolbar"]');
          const laser = root.querySelector('button[aria-label="Laser Cutter"]');
          laser.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            pointerType: 'touch',
          }));
          const controls = [...toolbar.querySelectorAll('button')];
          return {
            guide: root.querySelector('.guide').textContent,
            minWidth: Math.min(...controls.map((button) => button.getBoundingClientRect().width)),
            minHeight: Math.min(...controls.map((button) => button.getBoundingClientRect().height)),
            fontSize: Number.parseFloat(getComputedStyle(root.querySelector('.guide')).fontSize),
            barWidth: toolbar.getBoundingClientRect().width,
            viewportWidth: innerWidth,
          };
        })()`);

        assert(result.guide.includes("Laser Cutter"), "touch did not preview the laser");
        assert(result.guide.includes("clean cut"), "the touch guide omitted the laser gesture");
        assert(result.minWidth >= 44, `a custom-element control was ${result.minWidth}px wide`);
        assert(result.minHeight >= 44, `a custom-element control was ${result.minHeight}px tall`);
        assert(result.fontSize >= 14, `the custom-element guide was ${result.fontSize}px`);
        assert(
          result.barWidth <= result.viewportWidth,
          "the custom-element bar escaped the viewport",
        );
      } finally {
        await resize(original.width, original.height);
        await run("window.__ddElement?.remove(); delete window.__ddElement");
      }
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
  // `--cpu 6` reproduces a CI runner locally; the load-dependent failures in
  // this suite only surface once frames are slow enough to overlap real work.
  cpuRate: Number(readFlag("--cpu", "1")),
});

// A runtime error the page swallowed is still a defect; surface it as one.
const consoleErrors = [];
browser.cdp.on("Runtime.consoleAPICalled", (params) => {
  if (params.type !== "error") return;
  consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description).join(" "));
});

const run = (expression) => evaluate(browser.cdp, browser.sessionId, expression);
const resize = (width, height) =>
  browser.cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false },
    browser.sessionId,
  );

async function runAll(list, context) {
  let failed = 0;
  for (const check of selected(list)) {
    try {
      await check.run(run, context);
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

  failures += await runAll(checks, { resize });

  // The headless toolbar lives on its own page.
  await run(`location.href = ${JSON.stringify(`${server.origin}/examples/vanilla/index.html`)}`);
  await waitFor(
    browser.cdp,
    browser.sessionId,
    "document.documentElement.dataset.ready === 'true'",
    { label: "the vanilla example to wire up" },
  );

  failures += await runAll(exampleChecks, { resize });
  failures += await runAll(customElementChecks, { resize });

  if (consoleErrors.length > 0) {
    failures++;
    console.error("  FAIL the pages logged no console errors");
    for (const error of consoleErrors) console.error(`       ${error}`);
  }
} finally {
  await browser.close();
  await server.close();
}

const total = selected([...checks, ...exampleChecks, ...customElementChecks]).length;
if (failures > 0) {
  console.error(`\n${failures} of ${total} runtime checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${total} runtime checks passed.`);
