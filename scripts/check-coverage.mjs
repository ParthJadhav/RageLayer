/**
 * Coverage gate.
 *
 * Bun's built-in `coverageThreshold` is a *per-file* floor, which on a codebase
 * with WebGL modules that no headless DOM can execute means the only passing
 * value is one low enough to be meaningless. This enforces the two things that
 * actually matter instead:
 *
 *   1. a global ratchet, so overall coverage cannot quietly slide; and
 *   2. a per-module floor, so no module can be left entirely untested —
 *      except the ones listed as browser-only, which are covered by
 *      `scripts/browser-test.mjs` against real WebGL instead.
 *
 * Run after `bun test --coverage`, which writes `coverage/lcov.info`.
 */

import { readFile } from "node:fs/promises";

/** Global floors. Raise these when coverage rises; never lower them to go green. */
const GLOBAL = { lines: 0.84, functions: 0.82 };

/** Per-module floor for everything not exempt below. */
const PER_FILE = { lines: 0.5, functions: 0.5 };

/**
 * Modules that cannot run outside a real browser, with the reason. Each is
 * exercised by the runtime suite, which asserts the surface shader comes up,
 * the post-processing chain compiles, and snapshots encode.
 */
const BROWSER_ONLY = new Map([
  ["src/gl.ts", "WebGL program/texture creation"],
  ["src/postfx.ts", "WebGL post-processing chain"],
  ["src/surface.ts", "WebGL2 surface shader"],
  ["src/share.ts", "clipboard and download side effects"],
]);

/**
 * Bun 1.3.14 can zero source-line hits when lcov keeps a later transpiled
 * instance of the same module (oven-sh/bun#35345). Keep function coverage and
 * the global line ratchet enforced; skip only the corrupted per-file line
 * value until Bun merges instances correctly.
 */
const BUN_LCOV_LINE_EXEMPT = new Map([
  ["src/pointer-input.ts", "direct unit and engine tests; duplicated transpiled-module line map"],
]);

function parseLcov(text) {
  const files = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { file: line.slice(3).trim(), lines: [0, 0], functions: [0, 0] };
      files.push(current);
    } else if (!current) {
    } else if (line.startsWith("DA:")) {
      const hits = Number(line.slice(3).split(",")[1]);
      current.lines[1]++;
      if (hits > 0) current.lines[0]++;
    } else if (line.startsWith("FNF:")) {
      current.functions[1] = Number(line.slice(4));
    } else if (line.startsWith("FNH:")) {
      current.functions[0] = Number(line.slice(4));
    }
  }
  return files;
}

const ratio = ([hit, total]) => (total === 0 ? 1 : hit / total);
const percent = (value) => `${(value * 100).toFixed(2)}%`;

const report = parseLcov(await readFile("coverage/lcov.info", "utf8")).filter((entry) =>
  entry.file.startsWith("src/"),
);

if (report.length === 0) {
  console.error("No src/ coverage found. Run `bun test --coverage` first.");
  process.exit(1);
}

const totals = report.reduce(
  (sum, entry) => ({
    lines: [sum.lines[0] + entry.lines[0], sum.lines[1] + entry.lines[1]],
    functions: [sum.functions[0] + entry.functions[0], sum.functions[1] + entry.functions[1]],
  }),
  { lines: [0, 0], functions: [0, 0] },
);

const failures = [];
for (const metric of ["lines", "functions"]) {
  const value = ratio(totals[metric]);
  if (value < GLOBAL[metric]) {
    failures.push(
      `global ${metric} coverage ${percent(value)} is below the ${percent(GLOBAL[metric])} floor`,
    );
  }
}

for (const entry of report) {
  if (BROWSER_ONLY.has(entry.file)) continue;
  for (const metric of ["lines", "functions"]) {
    if (metric === "lines" && BUN_LCOV_LINE_EXEMPT.has(entry.file)) continue;
    const value = ratio(entry[metric]);
    if (value < PER_FILE[metric]) {
      failures.push(
        `${entry.file} ${metric} coverage ${percent(value)} is below the ${percent(PER_FILE[metric])} per-module floor`,
      );
    }
  }
}

for (const [file, reason] of BUN_LCOV_LINE_EXEMPT) {
  const entry = report.find((candidate) => candidate.file === file);
  if (!entry) {
    failures.push(`${file} has an lcov line exemption but no longer exists; drop the exemption`);
  } else if (ratio(entry.lines) > 0.8) {
    failures.push(
      `${file} now has ${percent(ratio(entry.lines))} line coverage; ` +
        `remove its Bun lcov exemption (${reason})`,
    );
  }
}

// Guard the exemptions themselves: a module that becomes unit-testable should
// lose its exemption rather than keep a free pass forever.
for (const [file, reason] of BROWSER_ONLY) {
  const entry = report.find((candidate) => candidate.file === file);
  if (!entry) {
    failures.push(`${file} is listed as browser-only but no longer exists; drop the exemption`);
    continue;
  }
  if (ratio(entry.lines) > 0.8) {
    failures.push(
      `${file} is now ${percent(ratio(entry.lines))} covered by unit tests; ` +
        `remove its browser-only exemption (${reason})`,
    );
  }
}

console.log(
  `Coverage: ${percent(ratio(totals.lines))} lines, ${percent(ratio(totals.functions))} functions ` +
    `across ${report.length} modules (${BROWSER_ONLY.size} browser-only).`,
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}
