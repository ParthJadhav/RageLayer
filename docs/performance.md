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

On displays faster than 60 Hz there is a rung between "high at native refresh" and "balanced":
when sustained cost outgrows the native frame budget but still fits a 60 fps frame with the usual
safety margin, the controller caps the frame rate at 60 and keeps every visual
(`snapshot.targetFps` drops to 60 and `qualityReason` says so). The cap releases only once cost
would also fit the native cadence comfortably, so it does not flap. Visual quality is reduced only
when even the 60 fps budget cannot be held.

Set an explicit tier to disable adaptation while keeping telemetry; `performance: false`
disables both.

## Telemetry

```ts
const engine = new RageLayerEngine({
  performance: {
    sampleIntervalMs: 1000,
    onSample(sample) {
      // fps, cpu p50/p95/p99/max, update/surface/render/postFX breakdown —
      // with the update step split per subsystem (tools/flames/bugs/
      // singularity/particles/physics), entity counts, capture/effects pixel
      // ratios, capture ms, quality tier, Chrome heap figures, plus:
      // sample.render  — avg fx buckets drawn per frame (wet/puffs/solids/hot),
      //                  flames drawn, physics bodies submitted
      // sample.surface — texSubImage2D uploads, uploaded pixels, full
      //                  reconciles, avg dirty-rect page coverage
      // sample.opacity — opacity-map sample() calls, path hit-tests, flattens
      // sample.gpu     — async GPU pass ms for the surface shader and post-FX
      //                  chain (timer-query extensions; `available` says so),
      //                  plus the probed per-upload canvas→texture cost
      //                  (`uploadCostMs`) that decides the GL fallbacks below
      // sample.capture — live-mode band recompose count + avg ms
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

Built-in tools declare their pending work too. A selected but settled tool does not keep rAF alive,
even while its 3D model remains visible under a stationary pointer; pointer movement redraws that
model on demand. Timed effects such as rockets, lightning restrikes, acid creep, and sticky-bomb
fuses continue in small background ticks even after the user selects another tool.

When an idle loop wakes, its simulation clock is rebased to the wake request. Time deliberately
spent asleep is therefore neither integrated as one catch-up step nor reported as a late frame.
Looped tool audio follows the same lifecycle: release ramps it down, then stops and disconnects the
silent WebAudio source; restarting during the short fade reuses that source instead of churning it.

The captured page keeps its independently budgeted device pixel ratio, while the transient effects
layer defaults to `effectsPixelRatio: 1`. This avoids a fourfold Canvas2D→WebGL upload on DPR-2
screens for imagery that is already soft, glowing, or in motion. Set a value up to `2` to opt into
supersampled effects; the engine clamps it to the device ratio.

## GPU upload probe

The shaded surface and the post-FX bloom both re-upload 2D canvas pixels into WebGL textures every
frame. Chromium does those transfers GPU-to-GPU (~0.01 ms); Firefox and Safari/WebKit currently pay
a fixed toll of several milliseconds *per upload call*, regardless of rectangle size — enough that
the two GL stages alone cost 100+ ms per frame under load. The first GL context the engine creates
therefore times a few small probe uploads once per page. Above the threshold (1 ms per call) the
WebGL2 surface shading and the WebGL post-FX chain stay on their plain-2D fallbacks: every
destruction visual (wounds, decals, particles, fire, physics) is unchanged, only glass-edge
shading, page warp, bloom, and heat shimmer switch off. The measured cost is reported as
`sample.gpu.uploadCostMs`, and the probe re-evaluates on every page load, so a browser that ships
fast uploads gets the full pipeline back automatically.

## Repeatable benchmarks

A network-free Chrome DevTools Protocol suite lives in `scripts/` (no Puppeteer/Playwright
dependency — raw CDP over WebSocket):

```sh
bun run benchmark          # idle, 1200 particles, 32 fires, 170 bodies, mixed — native CPU
bun run benchmark:low-end  # the same at 6× CPU throttling
bun run memory:check       # create/work/dispose cycles with forced GC — leak gate
bun run profile:effects    # all 16 tools, fixed high quality
bun run profile:effects:low-end
```

A cross-browser runner drives the same stress fixture in Firefox, WebKit, and Chrome via
Playwright (an optional devDependency — install with
`bun add -d playwright-core && bunx playwright-core install firefox webkit`):

```sh
bun run perf:browsers                      # all scenarios, firefox + webkit + chrome
node scripts/cross-browser.mjs --headed \
  --browsers firefox --scenarios mayhem    # windowed run of one engine/scenario
```

It reports rAF cadence and the engine's own snapshot breakdown per browser and writes
`SUMMARY.md`, `results.json`, and per-browser timegraphs. Chromium-only extras (CPU profiles,
traces, CPU throttling) remain in the CDP suite below.

Set `RAGELAYER_CHROME_PATH` to your Chrome binary. Output is JSON: browser task/script/layout time,
rAF percentiles, long tasks, heap deltas, entity counts, and the engine's own phase breakdown.
Add `--assert` to enforce the CI budgets for p95 engine cost, per-scenario heap growth, and layout
work; the optional `--max-engine-p95`, `--max-heap-growth`, and `--max-layout` flags override them.
A recorded baseline lives in
[`benchmarks/RESULTS.md`](https://github.com/ParthJadhav/RageLayer/blob/main/benchmarks/RESULTS.md).

### Isolate one effect

The effect profiler starts its own ephemeral static server unless `--url` is supplied, so the
command is self-contained. Fix the quality tier for before/after comparisons; `auto` is useful for
testing adaptation, but a tier change makes a rendering optimization impossible to isolate.

```sh
node scripts/profile-effects.mjs \
  --effects flamethrower \
  --cpu 6 \
  --duration 5000 \
  --quality high \
  --output artifacts/flamethrower-profile
```

Useful options:

| Option | Purpose |
| --- | --- |
| `--effects a,b` | Profile only the named tool IDs |
| `--cpu 6` | Apply Chrome's 6× CPU throttle |
| `--dpr 2` | Fix the device pixel ratio |
| `--quality high\|balanced\|low\|auto` | Fix or exercise the quality controller |
| `--variant no-postfx\|no-warp` | Disable one subsystem for diagnosis |
| `--metrics-only` | Skip the CPU profile and trace for a faster sweep |
| `--screenshots` | Capture the visual state beside the numeric report |
| `--url http://…` | Profile an already-served fixture or application |

Each non-metrics run writes a `.cpuprofile`, Chrome trace, and JSON summary. Compare at least three
runs with identical Chrome, viewport, DPR, quality, duration, and throttle settings; short Canvas2D
and GPU measurements vary enough that a single run can point in the wrong direction.

### Tool demo reel

`bun run demo:tools` records every built-in tool performing its scenario on the same fixed wood
surface in real Chrome. It writes a clip per tool, a stitched `all-tools.mp4`, 16 stills, and
`report.json` / `README.md` / a browsable `index.html` under `artifacts/tool-demo/`. Use
`node scripts/tool-demo.mjs --only acid-sprayer` for one tool, and `--cpu 6` to record what a slow
machine sees.

This is evidence for a person, not a gate. Nothing blocks on it, and the expectations printed beside
each clip are measured context rather than pass/fail — whether a structural cut has finished
reconciling at the instant a frame is sampled depends on the machine, not on the tool, and gating on
that produced only false alarms. Console errors are the exception and still fail the run. On GitHub,
trigger the **Tool demo** workflow by hand or label a pull request `tool-demo`; the reel lands as a
downloadable artifact.

## Distribution budgets

`scripts/check-dist.mjs` follows every relative JavaScript import from each public entry and measures
the complete graph. CI fails if any entry exceeds its reviewed allowance. Current measured graphs
are approximately 103 KiB gzip for all 16 tools and systems, 72 KiB for the engine without built-in
models, 20 KiB for base tools, 14 KiB for heavy tools, 10 KiB for advanced tools, and under 1 KiB
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
