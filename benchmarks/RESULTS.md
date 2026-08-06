# Runtime benchmark results

Measured on 2026-08-06 with Chrome 150 at 1280×720, device scale factor 1,
four-second samples after a one-second warm-up. The low-end pass uses Chrome's
6× CPU throttle. Run `bun run benchmark:low-end` to reproduce it.

The baseline is the feature worktree before the performance monitor, adaptive
profiles, pooled physics contacts, persistent WebGL texture storage, cached
uniforms, and idle-loop suspension were added.

## Low-end results

| Scenario | Main-thread task time | Improvement | Script time | Heap growth | Visual cadence |
| --- | ---: | ---: | ---: | ---: | ---: |
| Idle | 62.57 → 45.80 ms | 26.8% less | 19.74 → 6.76 ms | 243 → 120 KB | Engine sleeps; page remains 120 FPS |
| 1,200 particles | 2,285.56 → 1,276.94 ms | 44.1% less (1.79×) | 1,949.67 → 1,055.74 ms | 148 → 59 KB | 60 FPS engine / 120 FPS page, 0 drops |
| 32 fires | 3,851.97 → 2,506.54 ms | 34.9% less (1.54×) | 3,321.43 → 2,115.69 ms | 1.40 → 0.80 MB | 60 FPS engine / 120 FPS page, 0 drops |
| 170 rigid bodies | 2,460.21 → 1,212.93 ms | 50.7% less (2.03×) | 1,984.58 → 963.12 ms | 1.90 → 0.24 MB (7.81× lower) | 60 FPS engine / 120 FPS page, 0 drops |
| Mixed stress | 4,986.28 → 2,947.72 ms | 40.9% less (1.69×) | 4,546.32 → 2,551.87 ms | 5.38 → 1.19 MB (4.51× lower) | 75.78 → 119.79 page FPS; 60.1 engine FPS, 0 drops |

The final mixed sample used the balanced profile with a 7.5 ms p95 engine cost
inside a 16.7 ms target frame. The browser delivered no long frames or long
tasks. On native CPU, every active scenario remained on the high profile at
120 FPS; mixed stress measured 1.8 ms p95 engine cost.

## What each scenario stresses

- `idle`: scheduling and monitoring overhead with no entities.
- `particles`: classification, Canvas 2D drawing, full FX texture upload, and
  the post-processing composite.
- `fire`: multi-layer flame rendering, emissions, heat texture upload, bloom,
  and audio-loop bookkeeping.
- `physics`: SAT broadphase/contact solving, rigid-body integration, and debris
  sprite drawing.
- `mixed`: particles, fire, physics, Canvas 2D, and WebGL concurrently.

Browser task time includes the one-second warm-up; frame/heap measurements cover
the four-second sample. Results naturally vary with Chrome and hardware, so
compare changes using the same machine, viewport, duration, and throttle.
