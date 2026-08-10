import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const expected = {
  "dist/index.js": ["createDesktopDestroyer", "mountDesktopDestroyer", "DestroyerEngine"],
  "dist/engine/index.js": ["DestroyerEngine"],
  "dist/tools/index.js": ["baseTools", "hammer", "broom"],
  "dist/tools/heavy.js": ["heavyTools", "blackHole", "rocketLauncher"],
  "dist/tools/advanced.js": ["advancedTools", "gravityGun", "glitchGun"],
  "dist/lazy/index.js": [
    "loadBaseTools",
    "loadHeavyTools",
    "loadAdvancedTools",
    "loadDefaultTools",
  ],
  "dist/loadouts/index.js": ["BUILT_IN_LOADOUTS", "resolveToolLoadout"],
  "dist/sdk/index.js": ["defineTool", "createTool", "createRateLimiter"],
  "dist/react/index.js": ["DesktopDestroyer", "useDesktopDestroyer"],
  "dist/vue/index.js": ["useDesktopDestroyer"],
  "dist/svelte/index.js": ["desktopDestroyer", "createDesktopDestroyer"],
  "dist/element/index.js": ["DesktopDestroyerElement", "defineDesktopDestroyerElement"],
  "dist/toolbar/index.js": ["ToolbarModel", "DEFAULT_STRINGS", "resolveStrings"],
};

for (const [file, names] of Object.entries(expected)) {
  const source = await readFile(file, "utf8");
  if (file.includes("/react/") && !source.startsWith('"use client";')) {
    throw new Error(`${file} lost its React client boundary`);
  }

  const module = await import(new URL(`../${file}`, import.meta.url).href);
  for (const name of names) {
    if (!(name in module)) throw new Error(`${file} does not export ${name}`);
  }
}

const reactTypes = await readFile("dist/react/index.d.ts", "utf8");
if (reactTypes.startsWith('"use client";')) {
  throw new Error("dist/react/index.d.ts must not contain the JavaScript client directive");
}

// Engine-bearing entries include the vendored html-to-image capture chunk
// (bundled so dist works without a bundler; loaded lazily but reached through
// the engine's dynamic import, which this graph walk deliberately counts).
// Roughly 8% headroom over the real figures, so ordinary work fits and a
// structural regression does not. These are well below what the source's
// comment density suggests because the build strips JSDoc from the JavaScript
// output while keeping it in the `.d.ts` files (see tsdown.config.ts).
const budgets = {
  "dist/index.js": { raw: 404 * 1024, gzip: 111 * 1024 },
  "dist/engine/index.js": { raw: 296 * 1024, gzip: 78 * 1024 },
  "dist/tools/index.js": { raw: 70 * 1024, gzip: 21 * 1024 },
  "dist/tools/heavy.js": { raw: 47 * 1024, gzip: 15 * 1024 },
  "dist/tools/advanced.js": { raw: 37 * 1024, gzip: 11 * 1024 },
  "dist/lazy/index.js": { raw: 113 * 1024, gzip: 34 * 1024 },
  "dist/loadouts/index.js": { raw: 114 * 1024, gzip: 34 * 1024 },
  "dist/sdk/index.js": { raw: 4 * 1024, gzip: 2 * 1024 },
  "dist/react/index.js": { raw: 403 * 1024, gzip: 111 * 1024 },
  "dist/vue/index.js": { raw: 408 * 1024, gzip: 112 * 1024 },
  "dist/svelte/index.js": { raw: 383 * 1024, gzip: 104 * 1024 },
  // The custom element carries the engine plus the default toolset, the same
  // as any other ready-made toolbar entry.
  "dist/element/index.js": { raw: 406 * 1024, gzip: 111 * 1024 },
  // Headless: the toolbar model, the strings and the icon baker, with no
  // engine and no tools. This is the one to watch — if it ever approaches the
  // others, something has pulled the engine back into it.
  "dist/toolbar/index.js": { raw: 47 * 1024, gzip: 15 * 1024 },
};

async function entryGraph(file, seen = new Set()) {
  const absolute = resolve(file);
  if (seen.has(absolute)) return seen;
  seen.add(absolute);
  const source = await readFile(absolute, "utf8");
  const imports = source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+\.js)["']/g);
  for (const match of imports) await entryGraph(resolve(dirname(absolute), match[1]), seen);
  return seen;
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

for (const [entry, budget] of Object.entries(budgets)) {
  const graph = await entryGraph(entry);
  let raw = 0;
  let gzip = 0;
  for (const file of graph) {
    const source = await readFile(file);
    raw += source.byteLength;
    gzip += gzipSync(source, { level: 9 }).byteLength;
  }
  if (raw > budget.raw || gzip > budget.gzip) {
    throw new Error(
      `${entry} exceeds its bundle budget: ${kib(raw)} raw / ${kib(gzip)} gzip ` +
        `(limits: ${kib(budget.raw)} / ${kib(budget.gzip)})`,
    );
  }
  console.log(`${entry}: ${kib(raw)} raw / ${kib(gzip)} gzip`);
}

console.log("Distribution entry points, client boundary, and bundle budgets are valid.");
