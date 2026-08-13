import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "engine/index": "src/engine-entry.ts",
    "tools/index": "src/tools-entry.ts",
    "tools/heavy": "src/heavy-tools-entry.ts",
    "tools/advanced": "src/advanced-tools-entry.ts",
    "sdk/index": "src/sdk.ts",
    "lazy/index": "src/lazy.ts",
    "react/index": "src/react/index.ts",
    "vue/index": "src/vue/index.ts",
    "svelte/index": "src/svelte/index.ts",
    "element/index": "src/element-entry.ts",
    "toolbar/index": "src/toolbar-entry.ts",
  },
  format: ["esm"],
  platform: "browser",
  target: "es2020",
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: ["react", "react-dom", "vue"],
    // Inlined (as a lazy chunk — it is only ever dynamically imported) so the
    // dist bundle works without a bundler: the demo, harnesses, benchmarks and
    // CDN users all load dist/index.js directly, where a bare specifier would
    // fail to resolve and silently degrade capture to overlay mode.
    alwaysBundle: ["html-to-image"],
  },
  banner: ({ fileName }) => (fileName.startsWith("react/") ? { js: '"use client";' } : undefined),
  outputOptions: {
    // This codebase explains itself at length, and none of that prose is for
    // the consumer: it was ~28% of the shipped gzip. JSDoc is dropped from the
    // JavaScript bundle (the `.d.ts` files keep theirs, so editor tooltips are
    // unaffected) while two categories are deliberately preserved —
    // `annotation`, because `@__PURE__` is what makes tree-shaking work, and
    // `legal`, because the bundled html-to-image ships an MIT notice that has
    // to travel with the copy.
    comments: { legal: true, annotation: true, jsdoc: false },
  },
});
