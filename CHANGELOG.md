# desktop-destroyer

## 0.3.0

### Minor Changes

- [`ce9a406`](https://github.com/ParthJadhav/desktop-destroyer/commit/ce9a406f3b6b43d37512b7c3ebfcfc856855458e) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Realistic feedback effects, all procedural and physically motivated:

  - **Impact dust** — rigid debris chunks that land hard (or slam into each other) now knock a puff of pale paper dust loose at the contact point. Hooked into the physics solver's contact pass with a hard impulse threshold, rate-gated, and scaled by the quality profile.
  - **Ember dynamics** — burning pages shed drifting embers that ride the thermal plume, sway, flicker, and cool through the full white-orange → orange → dull-red arc (new `emberDark` sprite) before dying.
  - **Bullet ricochet** — an occasional round glances off instead of biting clean: a tight spark fan and exit streak leave along the deflected barrel line (aimed off `engine.toolAim`), with a graze of dust and a metallic tink.
  - **Water splashback** — hose droplets now splash _directionally_, keeping part of their arriving momentum, and one in three genuinely bounces back off the page and lands again downstream.
  - **Frost shatter glint** — fracturing frozen page throws a brief crystalline twinkle over the break, so ice reads as glass catching the light rather than pale paper.
  - **Smoke turbulence** — smoke columns curl with a second, height-keyed sway frequency so neighbouring puffs shear against each other instead of swaying in step. One extra `sin` per puff, no allocations.

### Patch Changes

- [`22ce63c`](https://github.com/ParthJadhav/desktop-destroyer/commit/22ce63ce689567ee93c1c3a2e7ee16501ee2e1e6) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Engine bug fixes: fire spread now respects the quality-scaled flame limit instead of the raw `maxFlames` option; a failed live refresh backs off and retries instead of permanently disabling scheduled refreshes (and no longer mutates the caller's `liveRefreshMs`); `spawnBugs` only plays its pop sound when a bug is actually released; tools gained an optional `reset()` hook that the engine invokes on `registerTool`, `clear()` and `dispose()`, so module-level tool state (in-flight rockets, lightning restrikes, hammer strike sites, aim smoothing, spawn debts) no longer leaks between engine instances; the performance monitor's frame sample buffer is now a proper wrap-around ring (long sample intervals no longer skew percentiles, and fps/frame counts reflect every observed frame); `dispose()` releases the damage-tool context wrapper and the opacity map's hit-test canvas backing; a `pagehide` listener restores the hidden page's visibility if the document navigates away mid-destruction; and documents taller than the 12000px capture cap now log a one-time warning instead of being silently truncated.

- [`da72ff7`](https://github.com/ParthJadhav/desktop-destroyer/commit/da72ff72c4acde65d953f89011af04a7f436e5ca) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - React wrapper fixes and accessibility pass.

  - StrictMode safety: `engine.setTool` no longer runs inside a `setState` updater; the engine now syncs from state in an effect.
  - Keyboard shortcuts ignore typing contexts (inputs, textareas, contenteditable, IME composition) and held-down key repeats, so pressing `R` in a search box no longer repairs the page.
  - SSR safety: the component renders `null` until mounted instead of calling `createPortal(…, document.body)` during server render — no `ssr: false` workaround needed.
  - `window.__desktopDestroyer` is now opt-in via the new `debugGlobal` prop (default off). `benchmarks/runtime.html` sets its own handle and is unaffected; pages profiled with `scripts/profile-effects.mjs` must pass `debugGlobal` to the React component.
  - The injected toolbar `<style>` is deduped (tagged `data-dd-toolbar-styles`, refcounted across instances) instead of stacking one copy per mount.
  - Accessibility: engine overlay container is `aria-hidden`; toolbar gets a roving tabindex with ArrowLeft/ArrowRight/Home/End navigation and a `:focus-visible` ring; the tool hint is a persistent `aria-live="polite"` region; focus moves into the toolbar on mount and returns to the previously focused element on close; `prefers-reduced-motion` disables the toolbar rise animation and hover motion. Known limitation: the engine has no reduced-motion knob yet, so in-canvas screen shake still plays under `prefers-reduced-motion`.
  - The toolbar wraps onto multiple rows on narrow viewports instead of clipping behind a hidden horizontal scroll.

- [`d35a488`](https://github.com/ParthJadhav/desktop-destroyer/commit/d35a488a2cb27630fea0151d0b33980a664b15c4) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Performance pass on the per-frame and page-query hot paths:

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

- [`78db15c`](https://github.com/ParthJadhav/desktop-destroyer/commit/78db15cb9b12e0a85158fb5365cb88ed17dcba57) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Code-quality sweep: truthful types, new exports, sprite-cache release, tests.

  - `captureFilter` is now truthfully typed `(node: Node) => boolean` — html-to-image
    calls the filter for every cloned node (text and comment nodes included), not just
    `HTMLElement`s. Existing element-typed callbacks keep working; docs examples now
    check `instanceof Element` before touching element-only APIs.
  - New exports from the core entry point: `downloadBlob`, `copyBlobToClipboard`,
    `snapshotFilename` (the share helpers the React toolbar uses, for hosts building
    their own toolbar) and `clearSpriteCache` (drops the shared baked-sprite atlas;
    rebuilt lazily on next use).
  - The sprite cache is now refcounted per engine: disposing the last live
    `DestroyerEngine` releases the baked sprite canvases automatically.
  - `SoundEngine.loop()` no longer creates an AudioContext from the engine's rAF loop
    while nothing is playing — audio comes up only on a real sound, inside a user
    gesture, as documented (removes Chrome's autoplay-policy warning with sound off).
  - Deduplicated polygon math (engine now uses `polygonArea2` from topology) and the
    `DD_IGNORE_ATTR` re-export; removed a stale doc comment and a pointless
    `captureFilter` reset in `dispose()`.
  - Docs corrected: black hole debris pull is inverse-linear (matching the solver),
    `flushBugs(x, y, r)` signature, `Tool.reset` hook and the React `toolStyle` /
    `debugGlobal` props are now documented.
  - New unit tests for fracture geometry (convex hull, Voronoi area conservation,
    grid partitioning, shard budget), the performance monitor (percentiles, ring
    buffer, adaptive quality laddering) and `pickPixelRatio` boundaries.
