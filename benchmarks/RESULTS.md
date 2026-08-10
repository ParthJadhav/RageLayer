# Runtime benchmark results

Measured on 2026-08-09 with Chrome 151 at 1280×720. Native samples use the same browser,
viewport, workload, warm-up, and duration on both sides of each comparison. Low-end samples use
Chrome's 6× CPU throttle. Results naturally vary by machine; compare changes with identical flags.

## Current optimization pass

| Workload | Before | After | Result |
| --- | ---: | ---: | ---: |
| DPR-2 flamethrower FPS | 25.40 | 59.27 | **2.33× faster** |
| DPR-2 flamethrower post-FX | 15.25 ms | 4.25 ms | **72.1% less** |
| DPR-2 flamethrower engine p95 | 18.90 ms | 5.50 ms | **70.9% less** |
| Native mixed-stress FPS | 48.32 | 57.64 | **19.3% faster** |
| Native mixed settled p95 | 16.80 ms | 2.10 ms | **87.5% less** |
| Native mixed dropped-frame estimate | 24 | 2 | **91.7% fewer** |
| 6× CPU fire FPS (2.2 s sample) | 15.49 | 25.72 | **66.0% faster** |
| Lightning FPS (1.5 s sample) | 49.57 | 55.18 | **11.3% faster** |

The DPR improvement comes from keeping transient effects at CSS-pixel resolution by default while
the captured/destructible page retains its independently budgeted device pixel ratio. Consumers can
opt back into supersampled effects with `effectsPixelRatio`.

The mixed and low-end gains come from making the balanced tier remove the measured post-processing
bottleneck, recognizing deferred Canvas2D/compositor pressure through sustained cadence, jumping
directly to low quality under catastrophic sustained load, and reducing only the emergency low-tier
entity budgets. One-off initialization spikes still do not lower quality.

Lightning no longer creates a second, redundant field of generic incendiary flames beneath its
dedicated channel fire. Its short sample improved to 55.18 FPS, and a 2.2-second sample settles at
about 60 FPS after the cadence-aware quality controller applies the balanced tier.

## Current native reference points

| Scenario | Cadence | Engine p95 | Notes |
| --- | ---: | ---: | --- |
| Idle | 59.7 FPS | 0 ms | Engine schedules no frames while idle |
| 1,200 particles | 60.1 FPS | 1.4 ms | No long or dropped frames |
| 170 rigid bodies | ~60 FPS | ~1.5 ms native | Sweep broadphase and pooled contacts |
| Mixed stress | 57.6 FPS overall | 2.1 ms settled | 900 particles, 24 flames, 150 bodies |

The short CI smoke uses `--assert` and currently passes a 25 ms engine-p95 ceiling, a 10 MB
per-scenario heap-growth ceiling, and a 50 ms layout-work ceiling. The separate leak gate checks
post-GC heap, DOM nodes, documents, listeners, layout objects, canvas disposal, and live engine
state.

## What each scenario stresses

- `idle`: scheduling and monitoring overhead with no entities.
- `particles`: classification, Canvas2D drawing, and effects-layer presentation.
- `fire`: multi-layer flames, emissions, heat upload, bloom, and loop bookkeeping.
- `physics`: broadphase/contact solving, integration, and debris sprite drawing.
- `mixed`: particles, fire, physics, Canvas2D, and WebGL concurrently.

Run `bun run benchmark`, `bun run benchmark:low-end`, `bun run memory:check`, and
`bun run profile:effects` to reproduce or extend the measurements.
