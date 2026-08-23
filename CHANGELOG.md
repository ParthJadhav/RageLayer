# RageLayer

## 2.1.0

### Minor Changes

- [#21](https://github.com/ParthJadhav/RageLayer/pull/21) [`8eb21a7`](https://github.com/ParthJadhav/RageLayer/commit/8eb21a7b739536cb453028cad41c01d2076e87a4) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Probe canvas→texture upload cost at runtime and keep the WebGL surface shading and post-FX bloom on their plain-2D fallbacks where uploads are slow. Chromium uploads canvas sources GPU-to-GPU (~0.01 ms) and keeps the full pipeline; Firefox and WebKit currently pay a fixed multi-millisecond toll per upload call, which made heavy scenes run at single-digit FPS (measured 4.5 → 45 FPS on the worst-case stress scenario in Firefox, 13 → 60 FPS in WebKit). Destruction visuals are unchanged on those browsers — only glass-edge shading, page warp, bloom, and heat shimmer switch off. The probed cost is reported as `sample.gpu.uploadCostMs` in performance snapshots, and a Playwright-based cross-browser stress runner (`bun run perf:browsers`) drives the same scenarios in Firefox, WebKit, and Chrome.

## 2.0.0

### Major Changes

- [#19](https://github.com/ParthJadhav/RageLayer/pull/19) [`eb78b20`](https://github.com/ParthJadhav/RageLayer/commit/eb78b20310d6b791da3e98d180d3fa755cb0e916) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Remove keyboard aiming and the whole-page collapse
  
  Two toolbar actions are gone, along with everything behind them.
  
  **The collapse action.** The `X` shortcut, the toolbar button, `engine.collapse()`, the
  element-by-element fall queue, and the `collapseMs` field of `PerformanceFrameBreakdown`.
  `harvestElements` still measures the page — `engine.demolish(x, y)` continues to knock individual
  elements loose, and `elementsInBand()` is still exported if you want to drive a wave yourself.
  
  **Keyboard aiming.** The `A` shortcut, the crosshair button, the arrow/`Enter`/`Esc` handling, the
  on-canvas reticle, `engine.setAim()`, `engine.aim`, `ToolbarModel.startAiming()`/`stopAiming()`/
  `moveAim()`/`strikeAtAim()`, the `aimStep` and `strikeHoldMs` model options, `ToolbarState.aim`,
  `ToolbarState.announcement` and its live region, and the `keyboardCursor`, `keyboardCursorHint`,
  `keyboardMoved` and `keyboardStruck` strings.
  
  ### Accessibility impact — please read
  
  Aiming mode was how a visitor without a pointing device actually *used* a tool. The toolbar remains
  fully keyboard-operable, but the canvas is a pointer surface and now has no built-in keyboard route:
  a keyboard-only visitor can select the hammer and not swing it.
  
  `engine.strike(x, y, { holdMs })` is unchanged and still public. It runs the same `onDown`/`onUp`
  pair a click produces and takes a history checkpoint, so a host that needs keyboard operation can
  rebuild it — supplying the cursor, the key handling, and the live region itself. Treat RageLayer as
  strictly optional decoration and keep real content and controls out from behind it.
  
  ### Migration
  
  - `engine.collapse()` — no replacement. Call `engine.demolish(x, y)` per element, or
    `engine.fracture(x, y, r, { power })` across the viewport.
  - `engine.setAim()` / `engine.aim` — track the cursor in your own state and draw it yourself.
  - `model.strikeAtAim()` — call `engine.strike(x, y, { holdMs: 260 })` with your own coordinates.
  - `state.aim` / `state.announcement` — removed from `ToolbarState`; own them in the host.
  - Custom `strings` objects: the four `keyboard*` keys and `collapse` are no longer read.
    `Partial<RageLayerStrings>` will now reject them as unknown properties.
  - `TOOLBAR_ICONS` no longer has `aim` or `collapse` entries, and `ToolbarIconName` no longer
    includes those names.
  - `PerformanceFrameBreakdown.collapseMs` — removed; the time it measured no longer exists.
  
  `formatString` is still exported, though no built-in string carries a placeholder now.

## 1.0.0

### Major Changes

- [`a084549`](https://github.com/ParthJadhav/RageLayer/commit/a0845493e9e14483ce1e5aa886ffa635478f97ee) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Remove tool loadouts and show the complete toolset everywhere. The `ragelayer/loadouts` entry point,
  `BUILT_IN_LOADOUTS`, `createToolLoadout()`, `resolveToolLoadout()`, the `loadout` option on
  `mountRageLayer()` / `createRageLayer()`, the `loadout` prop on the React and Vue components, and the
  `loadout` attribute on `<rage-layer>` are all gone. Every toolbar now registers and shows all sixteen
  built-in tools; pass a `tools` array to narrow the set. `mountRageLayer()` selects `"hammer"` when
  `initialTool` is omitted, as it already did without a loadout.

  Redesign the toolbar. Action buttons are single-path SVG icons drawn in `currentColor` instead of
  emoji, so their idle, hover and disabled states are driven by one colour token — disabled controls
  dim their ink rather than washing out the whole button, which had left undo and redo nearly
  invisible. The bar, hint pill and status chip share one set of surface tokens, the selected tool
  carries a tinted fill plus a dock-style accent marker, and buttons are 40px on desktop and a full
  44px once the row scrolls on narrow screens. `ToolbarButton.glyph` and `ToolbarButton.fontSize` are
  replaced by `ToolbarButton.iconPath`; the new `TOOLBAR_ICONS`, `toolbarIconSvg()` and
  `toolbarIconElement()` exports let a host-built toolbar render the same icons.

- [#10](https://github.com/ParthJadhav/RageLayer/pull/10) [`cecc8f2`](https://github.com/ParthJadhav/RageLayer/commit/cecc8f2b1bc745387bdc19fda099373b5638c292) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Rename the last `Destroyer*` public names to match the package. `DestroyerEngine` is now
  `RageLayerEngine`, `DestroyerEngineApi` is `RageLayerEngineApi`, `DestroyerOptions` is
  `RageLayerEngineOptions`, `DestroyerStrings` is `RageLayerStrings`, `DestroyerToolStrings` is
  `RageLayerToolStrings`, and the `<rage-layer>` element property `destroyerEngine` is
  `rageLayerEngine`. There are no deprecated aliases — the old names are gone, and
  `bun run check:package` asserts they stay gone.

  Migration is a rename in place; no behaviour, option, or DOM contract changed. Entry points
  (`ragelayer/react`, …), attributes (`data-ragelayer-*`) and events (`ragelayer-close`,
  `ragelayerchange`) were already correct and are untouched.

  The demo toolbar also showed a stale `Destroyer` brand label; it now reads `RageLayer`, matching
  every other piece of display text.

- [`a084549`](https://github.com/ParthJadhav/RageLayer/commit/a0845493e9e14483ce1e5aa886ffa635478f97ee) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Replace configurable page materials with one fixed wood-like physical response. This removes the
  material registry, material definitions and DOM material attributes from the public API. It also
  removes Freeze Ray, Wrecking Ball, and Glitch Gun, reducing the built-in set to 16 tools: seven base,
  five heavy, and four advanced.

  Laser Cutter now cuts structure immediately like the Chainsaw and drops isolated pieces. Acid
  Sprayer keeps visible and structural impacts aligned and spreads a short, bounded distance around
  each deposit, with a persistent reaction rim that stays clipped to surviving wood. Fire spreads
  across surviving content with a coherent baked flame body and a bounded smoke plume. Paintball
  supports automatic fire while held, and the Water Hose uses a compact pressure-nozzle model. The
  Gun model now has a more complete silhouette, working slide, and firing-cadence recoil.

  Toolbars also keep usage hints visible, share keyboard aiming and translations across React, Vue,
  and the custom element, and provide non-shrinking 44px touch targets on narrow screens.
  Built-in cooldowns, gesture paths and delayed effects are now isolated per engine, so simultaneous
  mounted layers cannot advance or clear one another's tool state. Timed effects continue after tool
  switches, while settled built-ins stop requesting idle animation frames even when their 3D model
  remains visible under a stationary pointer. Waking an idle loop no longer integrates its sleeping
  interval, and faded tool-audio loops are stopped and disconnected instead of processing silently.

### Patch Changes

- [`a084549`](https://github.com/ParthJadhav/RageLayer/commit/a0845493e9e14483ce1e5aa886ffa635478f97ee) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Live capture mode now shows DOM mutations. The mirror's repaint fast path redraws a mounted clone, so a counter ticking in page DOM — or anything inserted after the capture — never appeared on screen. A `MutationObserver` on the capture root (mutations inside `captureFilter`-excluded elements don't count) now marks the mirror stale so the next refresh re-clones, and the refresh loop presents the recomposed band itself so an idle page — whose frame loop is parked — actually shows it.

- [`278287c`](https://github.com/ParthJadhav/RageLayer/commit/278287c55ea964fcd02a35216ae53204ddbdd1c8) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Display text now reads `RageLayer` consistently. Console warnings use the `[RageLayer]` prefix instead of `[ragelayer]`, and shared screenshots download as `RageLayer-<timestamp>.png`. The package name, entry points (`ragelayer/react`, …), DOM attributes (`data-ragelayer-*`), and events (`ragelayer-close`, `ragelayerchange`) are unchanged — npm forbids uppercase in package names, and the DOM contracts stay case-stable.

## 0.6.1

### Patch Changes

- [`67a435e`](https://github.com/ParthJadhav/RageLayer/commit/67a435e8f7f4d0e146156d321eafbf28d069c4fd) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Harden npm releases with token-free trusted publishing and retry registry artifact downloads while a new version propagates.

## 0.6.0

### Minor Changes

- [`dcad2c8`](https://github.com/ParthJadhav/RageLayer/commit/dcad2c8e1d3f56e73d2a7c1b019f89b81e838096) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Rename the package and project to RageLayer. Public framework components and lifecycle helpers now use the `RageLayer` name, the Svelte action is `rageLayer`, and the custom element is `<rage-layer>`. Package-prefixed DOM attributes, events, constants, CSS hooks, and development environment variables now use the `ragelayer`, `RAGELAYER`, or `rl-` prefix.

## 0.5.0

### Minor Changes

- [`b3b99ea`](https://github.com/ParthJadhav/RageLayer/commit/b3b99eab59d80ddb01c08d4e1daa93f87f514ba5) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Rename the package and project to RageLayer. The React and Vue components are now `RageLayer`, lifecycle helpers are `createRageLayer`, `mountRageLayer`, and `useRageLayer`, the Svelte action is `rageLayer`, and the custom element is `<rage-layer>`. Package-prefixed DOM attributes, events, constants, and development environment variables now use the `ragelayer` or `RAGELAYER` prefix.

## 0.4.0

### Minor Changes

- [`1289409`](https://github.com/ParthJadhav/RageLayer/commit/12894091dc19266d5c91320c49709ace7bdc7f79) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Add a framework-neutral lifecycle controller, a headless React hook, a Vue composable, and a
  Svelte action. Publish explicit `react`, `vue`, and `svelte` entry points, preserve React's client
  boundary for Next.js, reduce the package contents, and add a documentation site and reliable npm
  release workflow. The engine now defaults sound off and follows `prefers-reduced-motion` for camera
  shake and nonessential UI transitions.

  Add size-focused `engine`, `tools`, `tools/heavy`, and `lazy` entry points; configurable procedural
  model scaling; exact built-in icon silhouettes that avoid canvas readbacks; explicit pause/resume;
  automatic hidden-tab suspension; data-saver quality detection; dynamic-layout observation; and
  robust primary-pointer capture/cancellation for touch and pen input.

  Add six advanced tools—Gravity Gun, Laser Cutter, Acid Sprayer, Wrecking Ball, Sticky Bombs, and
  Glitch Gun—with split loading and measured procedural-model bounds. Add material-aware fire,
  fracture, laser, acid, and electrical behavior; seven bounded spatial tool combos; opt-in,
  pixel-budgeted destruction undo/redo; immutable built-in and custom tool loadouts; and a typed
  state-isolated custom-tool SDK. Publish `tools/advanced`, `loadouts`, and `sdk` entry points and
  cover them in consumer fixtures, the live demo, package validation, and documentation.

  Cap the transient effects layer at CSS-pixel resolution by default to avoid DPR-squared
  Canvas2D-to-WebGL upload cost, with an `effectsPixelRatio` override for explicit supersampling.
  The balanced adaptive-quality tier now disables the measured post-processing bottleneck immediately
  instead of retaining it until a second downgrade.

- [`1289409`](https://github.com/ParthJadhav/RageLayer/commit/12894091dc19266d5c91320c49709ace7bdc7f79) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Add a ready-made toolbar for every stack, keyboard-operable tools, translatable strings, and a
  channel for reporting degradation.

  - `ragelayer/element` registers `<rage-layer>`, a complete toolbar in a shadow root
    that works unchanged in Svelte, Angular, Solid, Qwik, Astro and plain HTML. `/vue` now exports a
    `RageLayer` component alongside the composable. Both, and the React component, render one
    shared `ToolbarModel`, published as `ragelayer/toolbar` for hosts building their own UI.
  - Keyboard aiming makes the tools reachable without a pointer: `A` places a cursor on the page,
    arrows steer it, `Enter` uses the tool, and moves and strikes are announced. The underlying
    `engine.strike(x, y, { holdMs })` and `engine.setAim()` are public, and a keyboard blow is
    undoable like any other. Custom tools need no changes to be reachable this way.
  - Every user-visible string, including tool names and hints, can be replaced through `strings`, so
    the toy can be translated or reworded. `DEFAULT_STRINGS` and `resolveStrings()` are exported.
  - `onError` (option, `engine.onError()`, `engine.error` and an `"error"` event) reports the
    failures that were previously only a `console.warn`: capture failure, live-capture fallback,
    element-harvest failure, a missing text mask, and page-height truncation. Registering a handler
    silences the matching warning so nothing is logged twice.
  - `engine.historyEnabled` distinguishes "undo is on" from "there is something to undo", so a
    toolbar can show its undo controls from the start instead of having them appear mid-session.

### Patch Changes

- [`1289409`](https://github.com/ParthJadhav/RageLayer/commit/12894091dc19266d5c91320c49709ace7bdc7f79) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Bundle the `html-to-image` capture code into the package as a lazily-loaded chunk and drop the
  runtime dependency. Loading `dist` directly in a browser (the demo, harnesses, benchmarks, CDN
  usage) previously failed to resolve the bare specifier and silently degraded to overlay mode —
  no destructible page content, no fracture debris, and content-dependent tools (laser cutter, acid
  sprayer, bugs, demolition chunks) did nothing.

  Fix the broom leaving a trail of phantom torn-edge rings on intact pages: `ContentLayer.restore`
  now composes its pristine disc on a scratch canvas and stamps it in one draw, instead of a
  clip + clear + draw sequence that antialiased the rim twice and left a partial-alpha seam the
  surface shader shaded as a wound.

  Make the Glitch Gun read on light backgrounds: corruption now tears real page slices sideways and
  composites its interference bars with `difference` instead of `screen`, which was nearly invisible
  against white.

  The demo toolbar now exercises the full public surface: built-in loadout switching, undo/redo,
  whole-page repair, snapshot download, sound and pause toggles, combo toasts, and a live
  fps/capture status readout.

- [`1289409`](https://github.com/ParthJadhav/RageLayer/commit/12894091dc19266d5c91320c49709ace7bdc7f79) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Test the destruction pipeline for real, and harden the release path.

  Unit tests now run against a DOM with a real Canvas2D rasterizer, so the coverage map, wound
  compositing, physics solver and every built-in tool are asserted on actual pixels rather than
  mocks — 274 tests, up from 57, taking line coverage from 44% to 85%. A new runtime suite
  (`bun run test:browser`) drives the built package through headless Chrome and asserts what a
  visitor sees: the page is captured, the WebGL2 surface shader comes up, tools punch real holes,
  undo restores them, and disposing puts the real page back. Both run in CI, with coverage floors
  and a per-module gate.

  Also fixes `import "ragelayer/element"` throwing when evaluated on a server, and stops
  bundlers from tree-shaking away the element's registration.

## 0.3.0

### Minor Changes

- [`ce9a406`](https://github.com/ParthJadhav/RageLayer/commit/ce9a406f3b6b43d37512b7c3ebfcfc856855458e) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Realistic feedback effects, all procedural and physically motivated:

  - **Impact dust** — rigid debris chunks that land hard (or slam into each other) now knock a puff of pale paper dust loose at the contact point. Hooked into the physics solver's contact pass with a hard impulse threshold, rate-gated, and scaled by the quality profile.
  - **Ember dynamics** — burning pages shed drifting embers that ride the thermal plume, sway, flicker, and cool through the full white-orange → orange → dull-red arc (new `emberDark` sprite) before dying.
  - **Bullet ricochet** — an occasional round glances off instead of biting clean: a tight spark fan and exit streak leave along the deflected barrel line (aimed off `engine.toolAim`), with a graze of dust and a metallic tink.
  - **Water splashback** — hose droplets now splash _directionally_, keeping part of their arriving momentum, and one in three genuinely bounces back off the page and lands again downstream.
  - **Frost shatter glint** — fracturing frozen page throws a brief crystalline twinkle over the break, so ice reads as glass catching the light rather than pale paper.
  - **Smoke turbulence** — smoke columns curl with a second, height-keyed sway frequency so neighbouring puffs shear against each other instead of swaying in step. One extra `sin` per puff, no allocations.

### Patch Changes

- [`22ce63c`](https://github.com/ParthJadhav/RageLayer/commit/22ce63ce689567ee93c1c3a2e7ee16501ee2e1e6) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Engine bug fixes: fire spread now respects the quality-scaled flame limit instead of the raw `maxFlames` option; a failed live refresh backs off and retries instead of permanently disabling scheduled refreshes (and no longer mutates the caller's `liveRefreshMs`); `spawnBugs` only plays its pop sound when a bug is actually released; tools gained an optional `reset()` hook that the engine invokes on `registerTool`, `clear()` and `dispose()`, so module-level tool state (in-flight rockets, lightning restrikes, hammer strike sites, aim smoothing, spawn debts) no longer leaks between engine instances; the performance monitor's frame sample buffer is now a proper wrap-around ring (long sample intervals no longer skew percentiles, and fps/frame counts reflect every observed frame); `dispose()` releases the damage-tool context wrapper and the opacity map's hit-test canvas backing; a `pagehide` listener restores the hidden page's visibility if the document navigates away mid-destruction; and documents taller than the 12000px capture cap now log a one-time warning instead of being silently truncated.

- [`da72ff7`](https://github.com/ParthJadhav/RageLayer/commit/da72ff72c4acde65d953f89011af04a7f436e5ca) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - React wrapper fixes and accessibility pass.

  - StrictMode safety: `engine.setTool` no longer runs inside a `setState` updater; the engine now syncs from state in an effect.
  - Keyboard shortcuts ignore typing contexts (inputs, textareas, contenteditable, IME composition) and held-down key repeats, so pressing `R` in a search box no longer repairs the page.
  - SSR safety: the component renders `null` until mounted instead of calling `createPortal(…, document.body)` during server render — no `ssr: false` workaround needed.
  - `window.__rageLayer` is now opt-in via the new `debugGlobal` prop (default off). `benchmarks/runtime.html` sets its own handle and is unaffected; pages profiled with `scripts/profile-effects.mjs` must pass `debugGlobal` to the React component.
  - The injected toolbar `<style>` is deduped (tagged `data-ragelayer-toolbar-styles`, refcounted across instances) instead of stacking one copy per mount.
  - Accessibility: engine overlay container is `aria-hidden`; toolbar gets a roving tabindex with ArrowLeft/ArrowRight/Home/End navigation and a `:focus-visible` ring; the tool hint is a persistent `aria-live="polite"` region; focus moves into the toolbar on mount and returns to the previously focused element on close; `prefers-reduced-motion` disables the toolbar rise animation and hover motion. Known limitation: the engine has no reduced-motion knob yet, so in-canvas screen shake still plays under `prefers-reduced-motion`.
  - The toolbar wraps onto multiple rows on narrow viewports instead of clipping behind a hidden horizontal scroll.

- [`d35a488`](https://github.com/ParthJadhav/RageLayer/commit/d35a488a2cb27630fea0151d0b33980a664b15c4) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Performance pass on the per-frame and page-query hot paths:

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

- [`78db15c`](https://github.com/ParthJadhav/RageLayer/commit/78db15cb9b12e0a85158fb5365cb88ed17dcba57) Thanks [@ParthJadhav](https://github.com/ParthJadhav)! - Code-quality sweep: truthful types, new exports, sprite-cache release, tests.

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
    `RAGELAYER_IGNORE_ATTR` re-export; removed a stale doc comment and a pointless
    `captureFilter` reset in `dispose()`.
  - Docs corrected: black hole debris pull is inverse-linear (matching the solver),
    `flushBugs(x, y, r)` signature, `Tool.reset` hook and the React `toolStyle` /
    `debugGlobal` props are now documented.
  - New unit tests for fracture geometry (convex hull, Voronoi area conservation,
    grid partitioning, shard budget), the performance monitor (percentiles, ring
    buffer, adaptive quality laddering) and `pickPixelRatio` boundaries.
