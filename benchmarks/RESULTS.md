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

## 2026-08-13 flame-rendering pass

A controlled profile compared the old nine-blit flame body, the baked continuous four-blit
silhouette, and that silhouette with the final bounded smoke plume. Every run used Chrome 151, the
synthetic runtime fixture, 32 flames, DPR 2, fixed `quality: "high"`, 6× CPU throttling, and three
5-second samples. Values below are the three-run means; this isolates renderer/emission changes
rather than an adaptive-quality tier change.

| Measurement | Nine-blit body | Baked body | Baked + bounded plume | Final change |
| --- | ---: | ---: | ---: | ---: |
| Engine average | 10.90 ms | 7.48 ms | 4.62 ms | **57.6% lower** |
| Engine p95 | 13.40 ms | 8.73 ms | 5.47 ms | **59.2% lower** |
| Render phase | 3.99 ms | 2.79 ms | 2.03 ms | **49.1% lower** |
| Frame p95 | 14.17 ms | 10.67 ms | 10.60 ms | **25.2% lower** |
| Browser script time | 3,284 ms | 2,833 ms | 1,973 ms | **39.9% lower** |
| Live particles at capture | 1,244 | 1,241 | 787 | **36.7% fewer** |

The same change improves shape coherence: the hot body is one planted silhouette with independent
width/height flicker, while a conditional detached tongue preserves variation. Smoke now emits at
a bounded eight puffs per second at full intensity and lives for less time, making the hot body more
legible while cutting the largest source of particle overdraw. A proposed lower-frequency bloom
refresh was also profiled and removed because its three-run result did not show a reliable
improvement.

## 2026-08-13 fixed-high release sweep

After the rendering pass, all 16 tools were sampled for 1.8 seconds in Chrome 151 at DPR 2, fixed
`quality: "high"`, and 6× CPU throttling. This is a release smoke test, not a before/after
comparison: its purpose is to catch a tool-specific regression hidden by adaptive quality.

| Result | Observed |
| --- | ---: |
| Engine CPU p95 across all tools | **0.2–3.3 ms** |
| Worst engine CPU p95 | **3.3 ms** (Lightning) |
| Browser rAF p95 across all tools | **10.1–10.9 ms** |
| Frames over 20 ms | **0** |
| Long tasks | **0** |

Reproduce the sweep with `profile:effects:low-end`, adding `--quality high --duration 1800
--metrics-only` to the profiler invocation. The fixed tier is important: allowing an automatic
downgrade could make an expensive effect appear healthy by reducing its fidelity during the run.

## 2026-08-13 idle scheduling pass

Built-in tools now declare whether they own pending autonomous work. A settled selected tool lets
the requestAnimationFrame loop sleep; rockets, lightning restrikes, acid creep, and bomb fuses use a
small background tick and continue after selection changes. Older custom tools without the new
predicate retain their continuous-selected-tick contract for compatibility.

A controlled Chrome 151 comparison used the demo page, a 6× CPU throttle, and three alternating
2-second samples. “Legacy selected tick” was a no-op custom tool without `hasPendingWork`, which
reproduces the previous continuous scheduling behavior. Values are medians across the three runs.

| Steady selected state | Browser task time | Script time | Layout time |
| --- | ---: | ---: | ---: |
| Settled built-in | **0.159 ms** | **0 ms** | **0 ms** |
| Legacy continuous tick | 16.423 ms | 4.342 ms | 0.596 ms |

The real-browser runtime suite also watches the engine callback directly and fails if a settled,
visible 3D Hammer renders more than one engine frame during a 300 ms steady-state window.

The wake path also rebases the simulation clock. Before that correction, every post-idle effect
sample contained one synthetic 50 ms engine interval even though the browser's matching maximum was
under 15 ms. A 6×-CPU Chrome rerun across click, held, and background-work tools removed those 50 ms
samples; Hammer, Flamethrower, and Lightning then reported 10.3–10.4 ms engine maxima and zero
estimated dropped frames.

## 2026-08-13 full-lifecycle release sweep

The final gate profiled all 16 tools for five seconds each in Chrome 151 at DPR 2, fixed high
quality, and 6× CPU throttling. Unlike the shorter smoke above, this window includes complete rocket
flights, bomb fuses, detonations, and the retained work they emit. The profiler's assertion gate
passed.

| Result | Observed |
| --- | ---: |
| Engine CPU p95 across all tools | **0.1–8.7 ms** |
| Worst engine CPU p95 | **8.7 ms** (Sticky Bombs, including detonation) |
| Browser rAF p95 across all tools | **10.2–10.8 ms** |
| Browser frames over 20 ms | **0** |
| Long tasks | **0** |

Reproduce this longer release gate with `bun run profile:effects:low-end -- --assert`.

The matching 80-cycle mount/work/dispose gate retained zero DOM nodes, documents, listeners,
layout objects, or array buffers. Post-GC JavaScript heap ended 215,052 bytes above its baseline,
within the bounded allocator warm-up allowance, and every exposed engine collection, canvas, and
callback registry was empty after disposal.
