/**
 * Runs the stress suite in a stock (non-scriptable) browser — Zen, Firefox,
 * Safari — by opening benchmarks/stress.html?autorun=… with `open -a` and
 * collecting the results the page POSTs back to /report.
 *
 * Usage: node scripts/zen-run.mjs [--app Zen] [--scenarios mayhem,...]
 *   [--duration 6000] [--quality high] [--capture-mode auto] [--output dir]
 *
 * Unlike the Playwright runner this uses the user's real browser profile, so
 * it measures the graphics configuration people actually browse with.
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startStaticServer } from "./lib/browser.mjs";
import { frameSummary, round } from "./lib/report.mjs";

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const options = {
  app: readFlag("app", "Zen"),
  scenarios: readFlag("scenarios", "all"),
  durationMs: Math.max(2000, Number(readFlag("duration", "6000")) || 6000),
  quality: readFlag("quality", "high"),
  captureMode: readFlag("capture-mode", "auto"),
  output: readFlag("output", join("artifacts", "perf", `app-${Date.now()}`)),
  timeoutMs: Math.max(30_000, Number(readFlag("timeout", "180000")) || 180_000),
};

let reportResolve;
const report = new Promise((settle) => {
  reportResolve = settle;
});

const server = await startStaticServer("/benchmarks/stress.html", {
  onRequest: (request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/report")) return false;
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      response.end();
      try {
        reportResolve(JSON.parse(body));
      } catch (error) {
        reportResolve({ error: `bad beacon payload: ${error.message}` });
      }
    });
    return true;
  },
});

const query = new URLSearchParams({
  autorun: options.scenarios,
  duration: String(options.durationMs),
  quality: options.quality,
  captureMode: options.captureMode,
});
const url = `${server.origin}/benchmarks/stress.html?${query}`;
console.log(`Opening ${options.app}: ${url}`);
spawn("open", ["-a", options.app, url], { stdio: "inherit" });

const payload = await Promise.race([
  report,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timed out waiting for /report beacon")), options.timeoutMs),
  ),
]);

if (payload.error) {
  console.error(`Page reported error:\n${payload.error}`);
  process.exit(1);
}

console.log(`\n${payload.userAgent}`);
console.log(
  `DPR ${payload.devicePixelRatio}, viewport ${payload.viewport.width}×${payload.viewport.height}, ` +
    `capture ${payload.init?.captureStatus ?? "?"}\n`,
);
for (const sample of payload.results) {
  const frames = frameSummary(sample, 1000 / 60);
  const engine = sample.engine ?? {};
  console.log(
    `  ${sample.scenario.padEnd(12)} ${frames.fps.toFixed(1).padStart(5)} fps  ` +
      `p95 ${frames.p95Ms.toFixed(1).padStart(5)}ms  ` +
      `cpu p95 ${(engine.cpu?.p95 ?? 0).toFixed(1).padStart(5)}ms  ` +
      `quality ${engine.quality ?? "?"}  ` +
      `uploadCost ${(engine.gpu?.uploadCostMs ?? -1).toFixed(2)}ms`,
  );
}

await mkdir(options.output, { recursive: true });
await writeFile(join(options.output, "results.json"), JSON.stringify(round(payload), null, 2));
console.log(`\nArtifacts in ${options.output}`);
await server.close();
