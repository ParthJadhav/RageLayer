/**
 * Attribute Gecko-side frame cost to individual draw passes by interleaved
 * A/B: while a scenario runs, one pass is toggled on/off in 600ms windows and
 * frame intervals are compared between windows. Thermal drift hits both arms
 * equally, unlike sequential runs.
 *
 * Usage: node scripts/ff-passes.mjs [--browser firefox|chromium]
 *   [--scenario swarm] [--passes puffs,solids,...] [--duration 9000]
 *   [--viewport 1904x1034]
 */

import { startStaticServer } from "./lib/browser.mjs";

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const browserName = readFlag("browser", "firefox");
const scenario = readFlag("scenario", "swarm");
const durationMs = Number(readFlag("duration", "9000")) || 9000;
const [width, height] = readFlag("viewport", "1904x1034").split("x").map(Number);
const passNames = readFlag("passes", "puffs,solids,hot,wet,bugs,mask,shake,vignette").split(",");

/** In-page: wrap one pass with a skip flag. Returns false if the seam moved. */
function installPatch(pass) {
  const engine = window.__rageLayer;
  window.__skip = false;
  const guard =
    (original, self) =>
    (...rest) => {
      if (!window.__skip) original.apply(self, rest);
    };
  switch (pass) {
    case "puffs":
      if (typeof engine.fx?.drawPuffs !== "function") return false;
      engine.fx.drawPuffs = guard(engine.fx.drawPuffs, engine.fx);
      return true;
    case "solids":
      if (typeof engine.fx?.drawSolids !== "function") return false;
      engine.fx.drawSolids = guard(engine.fx.drawSolids, engine.fx);
      return true;
    case "hot":
      if (typeof engine.fx?.drawHot !== "function") return false;
      engine.fx.drawHot = guard(engine.fx.drawHot, engine.fx);
      return true;
    case "wet":
      if (typeof engine.fx?.drawWet !== "function") return false;
      engine.fx.drawWet = guard(engine.fx.drawWet, engine.fx);
      return true;
    case "bugs":
      if (typeof engine.bugs?.render !== "function") return false;
      engine.bugs.render = guard(engine.bugs.render, engine.bugs);
      return true;
    case "mask":
      if (typeof engine.maskFxToPage !== "function") return false;
      engine.maskFxToPage = guard(engine.maskFxToPage, engine);
      return true;
    case "shake":
      if (typeof engine.overlay?.stepShake !== "function") return false;
      engine.overlay.stepShake = guard(engine.overlay.stepShake, engine.overlay);
      return true;
    case "vignette":
      if (typeof engine.overlay?.setVignetteLevel !== "function") return false;
      engine.overlay.setVignetteLevel = guard(engine.overlay.setVignetteLevel, engine.overlay);
      return true;
    case "physics":
      if (typeof engine.physics?.render !== "function") return false;
      engine.physics.render = guard(engine.physics.render, engine.physics);
      return true;
    // Variant passes: skip=true swaps in an alternative implementation, so
    // "pass cost" reads as (original − variant) per frame.
    case "maskfull": {
      // The pre-tiling mask: one unclipped destination-in draw of the whole
      // band. skip=true runs it, so a negative pass cost means the current
      // (tiled) mask is faster than the old one.
      if (typeof engine.maskFxToPage !== "function") return false;
      const layer = engine.contentLayer;
      if (!layer?.surface) return false;
      const original = engine.maskFxToPage;
      engine.maskFxToPage = function (ctx, view) {
        if (!window.__skip) {
          original.call(this, ctx, view);
          return;
        }
        if (!layer.ready) return;
        const x0 = Math.max(0, view.left);
        const y0 = Math.max(0, view.top);
        const x1 = Math.min(layer.width, view.right);
        const y1 = Math.min(layer.height, view.bottom);
        if (x1 <= x0 || y1 <= y0) return;
        const d = layer.dpr;
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(
          layer.surface,
          x0 * d,
          y0 * d,
          (x1 - x0) * d,
          (y1 - y0) * d,
          x0,
          y0,
          x1 - x0,
          y1 - y0,
        );
        ctx.globalCompositeOperation = "source-over";
      };
      return true;
    }
    case "masksrcover":
    case "maskstatic": {
      if (typeof engine.maskFxToPage !== "function") return false;
      const layer = engine.contentLayer;
      if (!layer?.surface) return false;
      let source = layer.surface;
      if (pass === "maskstatic") {
        const snapshot = document.createElement("canvas");
        snapshot.width = layer.surface.width;
        snapshot.height = layer.surface.height;
        snapshot.getContext("2d").drawImage(layer.surface, 0, 0);
        source = snapshot;
      }
      const op = pass === "masksrcover" ? "source-over" : "destination-in";
      const original = engine.maskFxToPage;
      engine.maskFxToPage = function (ctx, view) {
        if (!window.__skip) {
          original.call(this, ctx, view);
          return;
        }
        if (!layer.ready) return;
        const x0 = Math.max(0, view.left);
        const y0 = Math.max(0, view.top);
        const x1 = Math.min(layer.width, view.right);
        const y1 = Math.min(layer.height, view.bottom);
        if (x1 <= x0 || y1 <= y0) return;
        const d = layer.dpr;
        ctx.globalCompositeOperation = op;
        ctx.drawImage(
          source,
          x0 * d,
          y0 * d,
          (x1 - x0) * d,
          (y1 - y0) * d,
          x0,
          y0,
          x1 - x0,
          y1 - y0,
        );
        ctx.globalCompositeOperation = "source-over";
      };
      return true;
    }
    case "maskperrect": {
      // Per-run destination-in draws, each under its own one-rect clip with a
      // cropped source — no multi-rect clip path for Gecko to rasterize.
      if (typeof engine.maskFxToPage !== "function") return false;
      const layer = engine.contentLayer;
      if (!layer?.surface || typeof layer.collectMaskRects !== "function") return false;
      const original = engine.maskFxToPage;
      const rects = [];
      engine.maskFxToPage = function (ctx, view) {
        if (!window.__skip) {
          original.call(this, ctx, view);
          return;
        }
        if (!layer.ready) return;
        const x0 = Math.max(0, view.left);
        const y0 = Math.max(0, view.top);
        const x1 = Math.min(layer.width, view.right);
        const y1 = Math.min(layer.height, view.bottom);
        if (x1 <= x0 || y1 <= y0) return;
        const d = layer.dpr;
        rects.length = 0;
        const known = layer.collectMaskRects(x0, y0, x1, y1, rects);
        if (view.bottom > y1)
          ctx.clearRect(view.left, y1, view.right - view.left, view.bottom - y1);
        if (view.right > x1) ctx.clearRect(x1, y0, view.right - x1, y1 - y0);
        if (known && rects.length === 0) return;
        if (!known) {
          ctx.globalCompositeOperation = "destination-in";
          ctx.drawImage(
            layer.surface,
            x0 * d,
            y0 * d,
            (x1 - x0) * d,
            (y1 - y0) * d,
            x0,
            y0,
            x1 - x0,
            y1 - y0,
          );
          ctx.globalCompositeOperation = "source-over";
          return;
        }
        for (let i = 0; i < rects.length; i += 4) {
          const rx = rects[i];
          const ry = rects[i + 1];
          const rw = rects[i + 2] - rx;
          const rh = rects[i + 3] - ry;
          ctx.save();
          ctx.beginPath();
          ctx.rect(rx, ry, rw, rh);
          ctx.clip();
          ctx.globalCompositeOperation = "destination-in";
          ctx.drawImage(layer.surface, rx * d, ry * d, rw * d, rh * d, rx, ry, rw, rh);
          ctx.restore();
        }
        ctx.globalCompositeOperation = "source-over";
      };
      return true;
    }
    case "maskdestout": {
      // Replace the mask with one trivial destination-out draw. Wrong visuals,
      // right measurement: if frames match the mask-skipped baseline, the
      // canvas deopt is specific to the destination-in family and a
      // holes-canvas + destination-out mask design is viable.
      if (typeof engine.maskFxToPage !== "function") return false;
      const dummy = document.createElement("canvas");
      dummy.width = dummy.height = 8;
      const original = engine.maskFxToPage;
      engine.maskFxToPage = function (ctx, view) {
        if (!window.__skip) {
          original.call(this, ctx, view);
          return;
        }
        ctx.globalCompositeOperation = "destination-out";
        ctx.drawImage(dummy, view.left, view.top, 8, 8);
        ctx.globalCompositeOperation = "source-over";
      };
      return true;
    }
    case "smokesrc48":
    case "smoketiny": {
      // Rerun the smoke/steam half of drawPuffs with a 48px stand-in sprite,
      // at real dest sizes (smokesrc48) or forced-tiny dests (smoketiny), to
      // separate source-sampling cost, dest-fill cost, and per-call overhead.
      if (typeof engine.fx?.drawPuffs !== "function") return false;
      const fx = engine.fx;
      const original = fx.drawPuffs;
      const tiny = pass === "smoketiny";
      const bake = (stops) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 48;
        const g = canvas.getContext("2d");
        const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
        for (const [offset, color] of stops) grad.addColorStop(offset, color);
        g.fillStyle = grad;
        g.fillRect(0, 0, 48, 48);
        return canvas;
      };
      const smokeSprite = bake([
        [0, "rgba(72, 68, 66, 0.85)"],
        [0.55, "rgba(72, 68, 66, 0.4)"],
        [1, "rgba(72, 68, 66, 0)"],
      ]);
      const warmSprite = bake([
        [0, "rgba(255, 150, 60, 0.85)"],
        [0.55, "rgba(170, 95, 50, 0.4)"],
        [1, "rgba(170, 95, 50, 0)"],
      ]);
      fx.drawPuffs = function (ctx, time) {
        if (!window.__skip) {
          original.call(this, ctx, time);
          return;
        }
        const saved = this.puff.slice();
        this.puff.length = 0;
        for (const p of saved) if (p.kind === "dust") this.puff.push(p);
        original.call(this, ctx, time);
        this.puff.length = 0;
        for (const p of saved) this.puff.push(p);
        for (const p of this.puff) {
          if (p.kind === "dust") continue;
          const t = p.life / p.maxLife;
          const grow = p.kind === "steam" ? 1 + t * 2.2 : 1 + t * 2.6;
          const radius = tiny ? 2 : p.size * grow;
          const fade = (1 - t) * Math.min(1, t * 5);
          if (p.kind !== "steam" && t < 0.35) {
            ctx.globalAlpha = 0.34 * fade * (1 - t / 0.35);
            ctx.drawImage(warmSprite, p.x - radius, p.y - radius, radius * 2, radius * 2);
          }
          ctx.globalAlpha = 0.3 * fade;
          ctx.drawImage(smokeSprite, p.x - radius, p.y - radius, radius * 2, radius * 2);
        }
        ctx.globalAlpha = 1;
      };
      return true;
    }
    case "dust":
    case "smoke": {
      if (typeof engine.fx?.drawPuffs !== "function") return false;
      const fx = engine.fx;
      const original = fx.drawPuffs;
      const dropKind = pass === "dust" ? "dust" : null;
      fx.drawPuffs = function (ctx, time) {
        if (!window.__skip) {
          original.call(this, ctx, time);
          return;
        }
        const saved = this.puff.slice();
        this.puff.length = 0;
        for (const p of saved) {
          // "dust" skips dust particles; "smoke" skips everything else.
          if (dropKind ? p.kind !== dropKind : p.kind === "dust") this.puff.push(p);
        }
        original.call(this, ctx, time);
        this.puff.length = 0;
        for (const p of saved) this.puff.push(p);
      };
      return true;
    }
    default:
      return false;
  }
}

/** In-page: run the scenario while toggling window.__skip every 600ms. */
async function runToggled([name, duration]) {
  const toggles = [];
  const timer = setInterval(() => {
    window.__skip = !window.__skip;
    toggles.push({ t: performance.now(), skip: window.__skip });
  }, 600);
  const startedAt = performance.now();
  toggles.push({ t: startedAt, skip: window.__skip });
  const sample = await window.stress.run(name, duration);
  clearInterval(timer);
  return { startedAt, toggles, intervals: sample.intervals };
}

let playwright;
try {
  playwright = await import("playwright-core");
} catch {
  console.error("playwright-core is not installed");
  process.exit(1);
}

const server = await startStaticServer("/benchmarks/stress.html");
const browser =
  browserName === "firefox"
    ? await playwright.firefox.launch({
        headless: false,
        firefoxUserPrefs: { "privacy.reduceTimerPrecision": false },
      })
    : await playwright.chromium.launch({ headless: false, channel: "chrome" });

const mean = (values) =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

try {
  console.log(`${browserName} — ${scenario}, ${durationMs}ms per pass, 600ms toggle windows`);
  for (const pass of passNames) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(`  page error: ${error.message}`));
    await page.goto(`${server.origin}/benchmarks/stress.html`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true", null, {
      timeout: 30000,
    });
    await page.evaluate(() => window.stress.init({ quality: "high" }));
    const applied = await page.evaluate(installPatch, pass);
    if (!applied) {
      console.log(`  ${pass.padEnd(9)} PATCH DID NOT APPLY`);
      await context.close();
      continue;
    }
    const { startedAt, toggles, intervals } = await page.evaluate(runToggled, [
      scenario,
      durationMs,
    ]);
    // Reconstruct each frame's absolute time, find its toggle window, and
    // drop 120ms after each flip (frames straddling the transition).
    const on = [];
    const off = [];
    let t = startedAt;
    for (const interval of intervals) {
      t += interval;
      let state = null;
      for (const toggle of toggles) {
        if (toggle.t <= t - interval) state = toggle;
        else break;
      }
      if (!state || t - interval - state.t < 120) continue;
      (state.skip ? off : on).push(interval);
    }
    const meanOn = mean(on);
    const meanOff = mean(off);
    console.log(
      `  ${pass.padEnd(9)} with ${meanOn.toFixed(1).padStart(5)}ms  ` +
        `without ${meanOff.toFixed(1).padStart(5)}ms  ` +
        `pass cost ${(meanOn - meanOff).toFixed(1).padStart(5)}ms/frame  ` +
        `(n=${on.length}/${off.length})`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
