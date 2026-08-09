# Performance

## Adaptive quality

Runtime measurement is built in and on by default. `quality: "auto"` starts from
`navigator.hardwareConcurrency` + `navigator.deviceMemory`, then moves between three profiles
(high / balanced / low) based on sustained measured frame cost, with hysteresis so a temporary
explosion doesn't permanently lower fidelity.

| Profile | What changes |
|---|---|
| high | Full particle/flame/body budgets, post-FX on, uncapped refresh |
| balanced | 60 updates/s cap on high-refresh displays, reduced invisible overdraw |
| low | Reduced solver iterations, direct 2D effects canvas (post-FX off), halved budgets |

Set an explicit tier to disable adaptation while keeping telemetry; `performance: false`
disables both.

## Telemetry

```ts
const engine = new DestroyerEngine({
  performance: {
    sampleIntervalMs: 1000,
    onSample(sample) {
      // fps, cpu p50/p95/p99/max, update/surface/render/postFX breakdown,
      // entity counts, capture ms, quality tier, Chrome heap figures
      sendToYourRUM(sample);
    },
  },
});

engine.performanceSnapshot;          // latest sample
const off = engine.onPerformance(cb); // subscribe; returns unsubscribe
```

The engine schedules no animation frames while idle — an open-but-untouched toy costs nothing.

## Repeatable benchmarks

A network-free Chrome DevTools Protocol suite lives in `scripts/` (no Puppeteer/Playwright
dependency — raw CDP over WebSocket):

```sh
bun run benchmark          # idle, 1200 particles, 32 fires, 170 bodies, mixed — native CPU
bun run benchmark:low-end  # the same at 6× CPU throttling
bun run memory:check       # create/work/dispose cycles with forced GC — leak gate
bun run profile:effects    # per-tool frame profiles
```

Set `DD_CHROME_PATH` to your Chrome binary. Output is JSON: browser task/script/layout time,
rAF percentiles, long tasks, heap deltas, entity counts, and the engine's own phase breakdown.
A recorded baseline lives in [`benchmarks/RESULTS.md`](../benchmarks/RESULTS.md).

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
