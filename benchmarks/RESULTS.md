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

## 2026-08-14 simultaneous-load stress pass

A new suite (`bun run perf`, `scripts/perf-suite.mjs` + `benchmarks/stress.html`) load-tests many
effects running at once on a real captured page — the headline `mayhem` scenario holds a
flamethrower drag while fractures, explosions, lightning, a black hole, bug swarms, and page shake
all fire continuously at the particle/flame/body caps. Seven scenarios ran 8 s each at 1× and
Chrome's 6× CPU throttle (Chrome 151, 1280×720, DPR 2, quality `auto`, snapshot capture), with CPU
profiles, flamegraphs, Chrome traces, GPU timings, and 1 Hz engine telemetry archived under
`artifacts/perf/`.

Optimizations in this pass: chunked same-style particle fills (state set once per alpha bucket, no
path over 24 subpaths), matrix-composed transforms instead of `save/restore` per solid/body,
pre-scaled decal stamp caching, pointer-event coalescing through a per-frame replay ring, a
persistent near-sorted physics broadphase, allocation-free particle/flame object pooling, a bounded
dirty-rect list (up to 8 rects) for surface uploads, a banded full-reconcile sweep instead of one
document-sized `texImage2D` stall, gated heat-canvas clears/uploads, and cached scroll offsets in
the pointer path.

| Result (worst scenario at 6× CPU throttle) | Before | After |
| --- | ---: | ---: |
| Frame p50 (`mayhem`) | 10.3 ms | **9.1 ms** |
| Frame p95 (`mayhem`) | 13.7 ms | **13.0 ms** |
| Frame p95 (`flood`) | 12.9 ms | **10.1 ms** |
| Worst frame (`mayhem`, 8 s) | 130 ms | **94 ms** |
| Surface upload traffic (`inferno`, 1×) | 58.6 M px/s | **21.9 M px/s** |
| Scenarios held at `high` quality, 6× | 2 of 7 | **3 of 7**, rest `balanced` |

Every scenario × throttle cell meets the 60 fps budget (p95 ≤ 17.5 ms, ≤ 5 % frames over 20 ms).
The larger structural win is capacity: `flood` and `debris` previously forced the adaptive
controller down to `balanced` at 6× and now run the full 8 s at `high` with ~40 % more live
particles and lower per-frame CPU. Two measured dead-ends are documented in
`src/fx-render.ts` (giant batched paths) and the git history (sprite mip chains) so they are not
retried.

Telemetry added with this pass (all in `PerformanceSnapshot`): per-subsystem update breakdown
(`toolsMs`…`physicsMs`), render bucket counts, surface upload/reconcile/coverage counters,
opacity-map hit-test counters, GPU pass timings via `EXT_disjoint_timer_query(_webgl2)`, and
live-capture recompose cost. Reproduce with `bun run perf`; emulate low-end with
`bun run perf:low-end`.

## 2026-08-14 quality-retention and memory pass

Goal: every stress scenario holds the **high** visual tier under low-end load, plus memory
reduction. Three changes landed:

**Rate-vs-quality ladder.** The adaptive controller previously budgeted the high tier against the
display's native refresh — on a 120 Hz panel that demanded engine cost fit 72% of 8.3 ms, so heavy
scenarios dropped to `balanced` (reduced budgets, no post-FX) chasing 120 fps. There is now a rung
between "high at native refresh" and "balanced": when sustained cost outgrows the native budget but
fits the 60 fps budget, the frame rate caps at 60 with every visual intact, releasing only with
sustained headroom against the native cadence. Cap eligibility is judged on p95 alone — one-off
fracture-storm spikes no longer force a visual downgrade that would not have prevented them.

Result (8 s scenarios, Chrome 151, 6× CPU throttle): **all 7 scenarios hold `high` for the entire
run** (previously 2 of 7; the rest sat in `balanced`), each meeting the 60 fps budget — worst
p95 16.9 ms (inferno), zero frames over 20 ms in 5 of 7. At 1× all scenarios run high at native
120 fps.

**Memory.** An allocation inventory showed the footprint is dominated by document-sized planes
(~80 MB each at the 20 Mpx capture budget; ~437 MB total in snapshot mode, ~587 MB in live mode on
a 1600×12000 page). Landed: live-mode wound/decal buffers now allocate at the tracked damage rect
(padded, grown geometrically with content-preserving re-blits) instead of the whole document —
~150 MB saved for a screenful of destruction, and live-mode undo checkpoints shrink
proportionally, which also re-enables history on tall pages where the checkpoint previously
exceeded its pixel budget. Evicted decal-stamp canvases release their backing store eagerly.
Documented for future work: a scroll-band surface renderer (~160 MB of GL on tall pages) and the
measured rejection of a half-resolution repair base (`restoreAll` blits it 1:1 to the visible
page).

**Measured experiments** (kept only if >20% off the relevant self-time, no p95 regression):
ImageBitmap sprite sources — no effect, Chrome's accelerated canvas sources are already
GPU-resident; `Path2D.addPath` batching — 4× slower than `ellipse()` appends; per-particle
`setTransform` + unit-circle fill — a wash. Kept: dust's baked 3-lobe cluster `Path2D`, one
uniform-scale stamp per particle — 53% off dust fill self-time, 26% off the swarm `drawPuffs`
pass. Cached-path stamping wins only when one stamp replaces three or more path appends.
