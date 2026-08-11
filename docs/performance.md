# Performance

## Adaptive quality

Runtime measurement is built in and on by default. `quality: "auto"` starts from
`navigator.hardwareConcurrency`, `navigator.deviceMemory`, and the browser's data-saver signal,
then moves between three profiles
(high / balanced / low) based on sustained measured frame cost, with hysteresis so a temporary
explosion doesn't permanently lower fidelity. Adaptation considers both synchronous engine time and
sustained late-frame cadence, because browsers can defer Canvas2D raster work until compositing;
cadence alone never triggers a downgrade when the engine's own work is cheap.

| Profile | What changes |
|---|---|
| high | Full particle/flame/body budgets, post-FX on, uncapped refresh |
| balanced | 60 updates/s cap, reduced budgets, direct 2D effects canvas |
| low | Reduced solver iterations, two-layer flames, direct 2D canvas, roughly one-third budgets |

Set an explicit tier to disable adaptation while keeping telemetry; `performance: false`
disables both.

## Telemetry

```ts
const engine = new DestroyerEngine({
  performance: {
    sampleIntervalMs: 1000,
    onSample(sample) {
      // fps, cpu p50/p95/p99/max, update/surface/render/postFX breakdown,
      // entity counts, capture/effects pixel ratios, capture ms, quality tier, Chrome heap figures
      sendToYourRUM(sample);
    },
  },
});

engine.performanceSnapshot;          // latest sample
const off = engine.onPerformance(cb); // subscribe; returns unsubscribe
```

The engine schedules no animation frames while idle. It also suspends simulation and looped audio
when the document is hidden by default. Hosts can preserve the current wreckage without doing frame
work via `engine.pause()` / `engine.resume()`.

The captured page keeps its independently budgeted device pixel ratio, while the transient effects
layer defaults to `effectsPixelRatio: 1`. This avoids a fourfold Canvas2D→WebGL upload on DPR-2
screens for imagery that is already soft, glowing, or in motion. Set a value up to `2` to opt into
supersampled effects; the engine clamps it to the device ratio.

## Repeatable benchmarks

A network-free Chrome DevTools Protocol suite lives in `scripts/` (no Puppeteer/Playwright
dependency — raw CDP over WebSocket):

```sh
bun run benchmark          # idle, 1200 particles, 32 fires, 170 bodies, mixed — native CPU
bun run benchmark:low-end  # the same at 6× CPU throttling
bun run memory:check       # create/work/dispose cycles with forced GC — leak gate
bun run profile:effects    # per-tool frame profiles
```

Set `RAGEKIT_CHROME_PATH` to your Chrome binary. Output is JSON: browser task/script/layout time,
rAF percentiles, long tasks, heap deltas, entity counts, and the engine's own phase breakdown.
Add `--assert` to enforce the CI budgets for p95 engine cost, per-scenario heap growth, and layout
work; the optional `--max-engine-p95`, `--max-heap-growth`, and `--max-layout` flags override them.
A recorded baseline lives in
[`benchmarks/RESULTS.md`](https://github.com/ParthJadhav/ragekit/blob/main/benchmarks/RESULTS.md).

## Distribution budgets

`scripts/check-dist.mjs` follows every relative JavaScript import from each public entry and measures
the complete graph. CI fails if any entry exceeds its reviewed allowance. Current measured graphs
are approximately 116 KiB gzip for all 19 tools and systems, 87 KiB for the engine without built-in
models, 27 KiB for base tools, 21 KiB for heavy tools, 11 KiB for advanced tools, and under 1 KiB
for the standalone SDK. The lazy loader's initial entry is under 1 KiB gzip.

These are distribution budgets, not the amount every application downloads. Consumer bundlers can
tree-shake unused public primitives, and lazy loading behind the launcher keeps the normal visit free
of engine code.

The memory gate fails on retained DOM nodes, documents, listeners, canvas backing stores,
simulation entities, tools, or performance callbacks, and bounds post-GC JS heap growth.

Both run in CI on every PR (short benchmark smoke + leak gate) — see
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Budgets worth knowing

- Canvas backing stores are capped at ~20M device pixels each (DPR steps down on tall pages);
  live mode keeps up to four document-sized canvases.
- Capture height is bounded at 12,000 px; taller documents are truncated.
- `MAX_BODIES = 190` rigid chunks; bodies sleep when they settle, which is what keeps a
  hundred-piece heap free.
- Particle budget 1400, flame budget 32, both scaled by the active quality profile.
- Combo history is capped at 64 interaction signals by default.
- Undo/redo is opt-in and rejects any checkpoint that would exceed its hard `maxPixels` budget.
