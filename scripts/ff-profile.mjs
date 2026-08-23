/**
 * Capture a Gecko profile of the stress harness in Playwright Firefox.
 *
 * The engine's own timers only see JS inside the rAF callback; on Firefox the
 * missing frame time lives in Gecko's canvas/compositor threads. The startup
 * profiler records every thread; this script runs scenarios, closes the
 * browser (which writes the profile), then prints per-thread top self-time so
 * the Gecko-side cost is attributable to real functions.
 *
 * Usage: node scripts/ff-profile.mjs [--scenarios swarm] [--duration 5000]
 *   [--viewport 1904x1034] [--output artifacts/perf/ff-profile.json]
 */

import { readFile } from "node:fs/promises";
import { startStaticServer } from "./lib/browser.mjs";

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const scenarios = readFlag("scenarios", "swarm").split(",");
const durationMs = Number(readFlag("duration", "5000")) || 5000;
const [width, height] = readFlag("viewport", "1904x1034").split("x").map(Number);
const output = readFlag("output", "artifacts/perf/ff-profile.json");

const playwright = await import("playwright-core");
const server = await startStaticServer("/benchmarks/stress.html");

const browser = await playwright.firefox.launch({
  headless: false,
  firefoxUserPrefs: { "privacy.reduceTimerPrecision": false },
  env: {
    ...process.env,
    MOZ_PROFILER_STARTUP: "1",
    MOZ_PROFILER_STARTUP_FEATURES: "js,stackwalk,cpu,markers",
    MOZ_PROFILER_STARTUP_ENTRIES: "16000000",
    MOZ_PROFILER_SHUTDOWN: output,
  },
});

try {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.goto(`${server.origin}/benchmarks/stress.html`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true", null, {
    timeout: 30000,
  });
  await page.evaluate(() => window.stress.init({ quality: "high" }));
  for (const scenario of scenarios) {
    const sample = await page.evaluate(
      ([name, duration]) => window.stress.run(name, duration),
      [scenario, durationMs],
    );
    const fps = (sample.intervals.length / sample.elapsedMs) * 1000;
    console.log(`${scenario}: ${fps.toFixed(1)} fps`);
    await page.evaluate(() => window.__rageLayer.clear());
  }
} finally {
  await browser.close();
  await server.close();
}

// ---- Analysis --------------------------------------------------------------
// Shutdown writes one profile per process: <output> plus <output>.<pid> files.
// Aggregate self-time per thread from every file present.
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const dir = dirname(output);
const stem = basename(output);
const files = (await readdir(dir)).filter((name) => name.startsWith(stem));
console.log(`\nProfiles: ${files.join(", ")}`);

// Raw Gecko format (meta.version 34): threads carry stackTable/frameTable/
// stringTable (no funcTable), native leaves are unsymbolicated "0x…" strings.
// Attribute those by library address range; JS frames keep their names.
for (const file of files) {
  let profile;
  try {
    profile = JSON.parse(await readFile(join(dir, file), "utf8"));
  } catch {
    continue;
  }
  const processes = [profile, ...(profile.processes ?? [])];
  for (const proc of processes) {
    const libs = (proc.libs ?? []).map((lib) => ({
      name: lib.name,
      start: parseInt(lib.start, 10),
      end: parseInt(lib.end, 10),
    }));
    const libOf = (address) => libs.find((lib) => address >= lib.start && address < lib.end);
    for (const thread of proc.threads ?? []) {
      const { samples, stackTable, frameTable, stringTable } = thread;
      const data = samples?.data ?? [];
      if (data.length < 500) continue; // skip mostly-idle threads
      const stackIndex = samples.schema.stack;
      const frameOfStack = stackTable.schema.frame;
      const locationOfFrame = frameTable.schema.location;
      const selfCounts = new Map();
      let total = 0;
      for (const row of data) {
        const stack = row[stackIndex];
        if (stack == null) continue;
        total++;
        const frame = stackTable.data[stack][frameOfStack];
        const location = stringTable[frameTable.data[frame][locationOfFrame]];
        const key = location.startsWith("0x")
          ? `[native] ${libOf(parseInt(location, 16))?.name ?? "?"}`
          : location;
        selfCounts.set(key, (selfCounts.get(key) ?? 0) + 1);
      }
      if (total < 500) continue;
      const top = [...selfCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
      console.log(`\n== ${file} :: pid ${thread.pid} ${thread.name} — ${total} samples`);
      for (const [name, count] of top) {
        console.log(`  ${((count / total) * 100).toFixed(1).padStart(5)}%  ${name.slice(0, 100)}`);
      }
    }
  }
}
