---
"desktop-destroyer": patch
---

Performance pass on the per-frame and page-query hot paths:

- `OpacityMap` no longer grows without bound under sustained destruction: when a
  128px cell accumulates more than 32 wound operations they are flattened — in
  order, clipped to the cell — into a map-resolution resolved plane and their
  `Path2D`s are freed. `onPage()`/`opacityAt()` queries now walk a bounded list
  (recent wounds stay geometrically exact; only flattened history resolves at
  the opacity map's own pixel resolution), where a long flamethrower session
  used to make every query slower and retain every path ever punched.
- The `surfaceCtx` proxies (`atopAsOver`, live-mode `teeContexts`) memoize their
  method bindings/wrappers instead of allocating a fresh bound closure on every
  property access in the decal-drawing hot path.
- `PhysicsWorld.active` is now a cached flag settled by the body walk `step()`
  already performs (conservatively raised by `add`/`blast`/`attract`/floor
  moves) instead of re-scanning every body once per frame.
- Flash/jet particle presence is tracked with an exact counter maintained by the
  particle lifecycle, replacing the two full particle-array scans per frame in
  the post-FX demand and bloom-strength checks.

Measured with the CDP benchmark (headless Chrome, 2×2.5s runs per side): the
steady-state scenarios are unchanged within run-to-run noise (engine CPU p95 —
particles ~1.3–1.4ms, fire ~17.7–18.9ms, physics 0.9–1.1ms, mixed 1.4–1.6ms
on both sides; physics updateMs edged down 0.45–0.50 → 0.39–0.43ms). These
changes are about bounding cost growth under sustained real-page destruction
(wound queries, decal proxying) rather than moving the synthetic scenario
averages. Leak gate stays green. No visual or public API changes.
