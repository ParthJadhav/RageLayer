---
"desktop-destroyer": minor
---

Add a framework-neutral lifecycle controller, a headless React hook, a Vue composable, and a
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
