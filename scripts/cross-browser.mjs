/**
 * Cross-browser perf runner: drives benchmarks/stress.html in Firefox, WebKit
 * and Chromium via Playwright, reusing the same in-page scenario harness as
 * scripts/perf-suite.mjs. Chromium-only CDP extras (CPU profiles, traces,
 * throttling) live in perf-suite.mjs; this runner keeps only the
 * browser-neutral signal — rAF cadence + engine performance snapshots — so the
 * numbers are comparable across engines.
 *
 * Usage: node scripts/cross-browser.mjs [--browsers firefox,webkit,chromium]
 *   [--scenarios mayhem,inferno,...] [--duration 8000] [--dpr 2]
 *   [--quality high] [--capture-mode auto] [--headed] [--output dir]
 *
 * Requires the optional devDependency `playwright-core` plus browser builds
 * (`bunx playwright-core install firefox webkit`). Chromium prefers the
 * installed Google Chrome (channel "chrome") and falls back to the bundled
 * build.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startStaticServer } from "./lib/browser.mjs";
import { frameSummary, round, timegraphHtml } from "./lib/report.mjs";

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const hasFlag = (name) => args.includes(`--${name}`);

const options = {
  browsers: readFlag("browsers", "firefox,webkit,chromium")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  scenarios: readFlag("scenarios", "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
  durationMs: Math.max(2000, Number(readFlag("duration", "8000")) || 8000),
  dpr: Math.max(1, Number(readFlag("dpr", "2")) || 2),
  quality: readFlag("quality", "high"),
  captureMode: readFlag("capture-mode", "auto"),
  headed: hasFlag("headed"),
  viewport: readFlag("viewport", "1280x720"),
  output: readFlag("output", join("artifacts", "perf", `cross-${stamp()}`)),
};
const [viewportWidth, viewportHeight] = options.viewport.split("x").map(Number);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

let playwright;
try {
  playwright = await import("playwright-core");
} catch {
  console.error(
    "playwright-core is not installed. Run: bun add -d playwright-core && bunx playwright-core install firefox webkit",
  );
  process.exit(1);
}

/** Launch one engine; returns { browser, label }. */
async function launchBrowser(name) {
  const headless = !options.headed;
  if (name === "firefox") {
    const browser = await playwright.firefox.launch({
      headless,
      firefoxUserPrefs: {
        // Full-resolution performance.now() so frame intervals and the
        // engine's per-subsystem breakdown are not quantised to 1ms.
        "privacy.reduceTimerPrecision": false,
      },
    });
    return { browser, label: `firefox ${browser.version()}` };
  }
  if (name === "webkit") {
    const browser = await playwright.webkit.launch({ headless });
    return { browser, label: `webkit ${browser.version()}` };
  }
  if (name === "chromium" || name === "chrome") {
    try {
      const browser = await playwright.chromium.launch({ headless, channel: "chrome" });
      return { browser, label: `chrome ${browser.version()}` };
    } catch {
      const browser = await playwright.chromium.launch({ headless });
      return { browser, label: `chromium ${browser.version()}` };
    }
  }
  throw new Error(`Unknown browser "${name}" (expected firefox, webkit, chromium)`);
}

async function runBrowser(name, origin) {
  const { browser, label } = await launchBrowser(name);
  const results = [];
  try {
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      deviceScaleFactor: options.dpr,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(`  [${name}] page error: ${error.message}`));
    await page.goto(`${origin}/benchmarks/stress.html`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true", null, {
      timeout: 30000,
    });
    const init = await page.evaluate((opts) => window.stress.init(opts), {
      quality: options.quality,
      captureMode: options.captureMode,
    });
    const names =
      options.scenarios.length > 0
        ? options.scenarios
        : await page.evaluate(() => window.stress.scenarios);
    console.log(`${label} — capture ${init.captureStatus}, scenarios: ${names.join(", ")}`);
    for (const scenario of names) {
      const sample = await page.evaluate(
        ([scenarioName, durationMs]) => window.stress.run(scenarioName, durationMs),
        [scenario, options.durationMs],
      );
      const frames = frameSummary(sample, 1000 / 60);
      const engine = sample.engine ?? {};
      results.push({ scenario, frames, sample });
      console.log(
        `  ${scenario.padEnd(12)} ${frames.fps.toFixed(1).padStart(5)} fps  ` +
          `p95 ${frames.p95Ms.toFixed(1).padStart(5)}ms  ` +
          `cpu p95 ${(engine.cpu?.p95 ?? 0).toFixed(1).padStart(5)}ms  ` +
          `quality ${engine.quality ?? "?"}`,
      );
      await page.evaluate(() => window.__rageLayer.clear());
      await page.waitForTimeout(600);
    }
  } finally {
    await browser.close();
  }
  return { name, label, results };
}

function summaryMarkdown(runs) {
  const lines = [
    "# Cross-browser stress results",
    "",
    `Duration ${options.durationMs}ms per scenario, DPR ${options.dpr}, quality "${options.quality}", ` +
      `viewport ${options.viewport}, ${options.headed ? "headed" : "headless"}.`,
    "",
    "| Scenario | " + runs.map((run) => run.label).join(" | ") + " |",
    "| --- | " + runs.map(() => "---").join(" | ") + " |",
  ];
  const scenarios = runs[0]?.results.map((entry) => entry.scenario) ?? [];
  for (const scenario of scenarios) {
    const cells = runs.map((run) => {
      const entry = run.results.find((candidate) => candidate.scenario === scenario);
      if (!entry) return "—";
      const cpu = entry.sample.engine?.cpu?.p95 ?? 0;
      return `${entry.frames.fps.toFixed(1)} fps, p95 ${entry.frames.p95Ms.toFixed(1)}ms, cpu ${cpu.toFixed(1)}ms, ${entry.sample.engine?.quality ?? "?"}`;
    });
    lines.push(`| ${scenario} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

const server = await startStaticServer("/benchmarks/stress.html");
const runs = [];
try {
  for (const name of options.browsers) {
    runs.push(await runBrowser(name, server.origin));
  }
} finally {
  await server.close();
}

await mkdir(options.output, { recursive: true });
await writeFile(join(options.output, "SUMMARY.md"), summaryMarkdown(runs));
await writeFile(
  join(options.output, "results.json"),
  JSON.stringify(
    round(
      runs.map((run) => ({
        name: run.name,
        label: run.label,
        results: run.results.map(({ scenario, frames, sample }) => ({
          scenario,
          frames,
          engine: sample.engine,
          snapshots: sample.snapshots,
        })),
      })),
    ),
    null,
    2,
  ),
);
for (const run of runs) {
  const series = run.results.map(({ scenario, sample }) => ({
    label: scenario,
    snapshots: sample.snapshots,
  }));
  await writeFile(
    join(options.output, `timegraph-${run.name}.html`),
    timegraphHtml(series, `${run.label} stress timelines`),
  );
}
console.log(`\nArtifacts in ${options.output}`);
