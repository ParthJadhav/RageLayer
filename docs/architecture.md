# Architecture

How the package turns a live page into a destructible object. Deeper dives:
the [repository README](https://github.com/ParthJadhav/RageLayer#readme) covers the public
overview, and [HTML-IN-CANVAS.md](https://github.com/ParthJadhav/RageLayer/blob/main/HTML-IN-CANVAS.md)
is the research log behind live capture mode.

## The layer model

Everything works in document CSS pixels. The engine appends one `position: absolute` container
(z-index `2147483000` by default) holding five stacked layers:

| Layer | Module | Role |
|---|---|---|
| void `div` | `engine.ts` | The dark "behind the page" — a CSS gradient revealed through holes |
| content canvas | `content.ts` / `surface.ts` | The rasterized page — the destructible surface |
| damage canvas | `engine.ts` | Persistent overlay decals; the fallback surface when capture is off |
| fx canvas | `engine.ts` / `postfx.ts` | Per-frame effects — viewport-sized, parked over the visible band |
| vignette `div` | `engine.ts` | Destruction-meter glow; only `opacity` animates |

On activation the live DOM is rasterized (via `html-to-image`'s foreignObject technique), the
real DOM is hidden with `visibility: hidden` (layout and scrolling survive), and the raster
becomes the page. A pristine copy is kept so the broom and `clear()` genuinely restore content.

The physics layer treats every surviving page pixel as the same wood-like surface. A single internal
response supplies toughness, density, flammability, conductivity, corrosion resistance, and rebound;
DOM regions and engine options do not replace it.

## Module map

```
src/
├── engine.ts        RageLayerEngine orchestration — DOM, rAF, input, destruction,
│                    subsystems, history, telemetry, quality and public methods
├── engine-options.ts Runtime defaults, validation and normalized engine options
├── types.ts         The full public type surface (RageLayerEngineOptions, Tool, …)
├── content.ts       ContentLayer — the destructible page: punch/burn/cut/char/restore,
│                    pristine base, live-mode wound/decal recomposition, OpacityMap
├── capture.ts       Capture fidelity: backdrop recovery, seam-free geometry,
│                    dev-overlay filtering, fixed-position pinning, DPR budgeting
├── live.ts          LiveContentSource — experimental html-in-canvas re-capture
├── surface.ts       SurfaceRenderer — WebGL2 shading of the page: refraction,
│                    dispersion, rim light and slab depth along torn edges
├── postfx.ts        PostFX — bloom, heat-haze, chromatic aberration over the fx canvas
├── gl.ts            Small WebGL helpers shared by surface.ts
├── physics.ts       PhysicsWorld/Body — sequential-impulse rigid bodies, sleeping,
│                    sweep-and-prune broadphase, blast/attract
├── fracture.ts      Voronoi/grid shattering + chunk sprite baking
├── particles.ts     Bounded particle storage and simulation
├── flames.ts        Wood fuel, contact heat, bounded fire spread and smoke emission
├── topology.ts      Surface connectivity: detached-region detection, stroke↔surface
│                    clipping and shared scan-bound accumulation
├── elements.ts      Pre-capture DOM measurement for demolition
├── textmask.ts      Text-line mask so refraction backs off over glyphs
├── decals.ts        Procedural persistent marks (cracks, holes, scorch, gashes, splats…)
├── sprites.ts       Lazily-baked gradient sprites for the hot particle paths
├── tools.ts         Hammer, gun, flamethrower, hose, chainsaw, paintball, broom
├── heavy-tools.ts   Demolition, rocket, lightning, black hole, bugs
├── advanced-tools.ts Gravity gun, laser cutter, acid sprayer, sticky bombs
├── tool-kit.ts      Shared particle emissions and engine-keyed tool state
├── wood.ts          Fixed physical response for the destructible page surface
├── combos.ts        Bounded spatial interaction tracker and combo definitions
├── history.ts       Pixel-budgeted undo/redo stack with deterministic disposal
├── sdk.ts           Typed stateful custom-tool factories and rate scheduling
├── default-tools.ts Official ordering that combines all built-in toolsets
├── lazy.ts          On-demand base/heavy/advanced/complete tool loaders
├── toolart/         Hand-drawn pseudo-3D tool renderings + toolbar icon baking
├── advanced-toolart.ts Split procedural models for advanced tools
├── cursors.ts       emojiCursor()
├── audio.ts         SoundEngine — fully procedural WebAudio
├── performance.ts   Quality profiles, device detection, frame telemetry ring
├── share.ts         Blob download / clipboard helpers
└── react/           RageLayer component + toolbar
```

## Tool instance state

Built-in tools are immutable module-level objects so they can be shared across entry points and
engines. Their mutable work is not shared: cooldowns, gesture paths, spawn debt, strike history,
queued projectiles and delayed effects live in `WeakMap` stores keyed by `RageLayerEngineApi`.
Registering, clearing, unregistering or disposing a tool resets only the calling engine's entry.
This lets two mounted RageLayer layers use the same exported tool at the same time without one
layer advancing, clearing or redirecting the other's work, and lets garbage collection reclaim a
disposed engine without a global registry.

Custom stateful tools should use `defineTool()` from `ragelayer/sdk`, which creates independent
state by construction. A direct `Tool` implementation that retains work should apply the same
engine-keyed rule and clear its entry from `reset(engine)`.

Tools with autonomous work expose `hasPendingWork` and `backgroundTick`: rockets, lightning
restrikes, acid creep, and bomb fuses continue after selection changes, while settled built-ins let
the requestAnimationFrame loop sleep when the pointer and effects are idle. A visible 3D tool stays
as a retained canvas image while the pointer is still; the next pointer event redraws it on demand.

## The frame loop

The engine schedules **no animation frames while idle** — pointer input, scrolling, capture
completion, tool selection and new entities wake it on demand. Hidden documents and explicit host
pauses cancel the pending frame and resume against a fresh clock, so time away is never integrated as
one giant physics step.

```
frame:
  update   selected tick + pending background tools → flames → bugs
           → singularity → particles → physics
  surface  dirty-rect texSubImage2D upload + scissored shader pass
  render   particles (4 blend buckets) → flames → mask-to-page-alpha → debris
           → singularity → additive pass → tool art → present → post-FX
  adapt    telemetry sample → quality tier hysteresis
```

Two invariants are load-bearing (and covered by `harness.html`):

- **An undamaged page is bit-identical to the raster.** Every shader term scales with the
  alpha gradient, which is zero across intact page.
- **The silhouette stays exact.** Output alpha is the unrefracted sample, so refraction never
  drags opaque pixels into a hole.

## The void

The surface's alpha channel *is* the wound field. Every tool consults `onPage(x, y)` /
`pageOpacityAt(x, y)` before doing surface work: bullets sail through holes, lightning doesn't
ground, decals clip themselves to surviving pixels. Only airborne things (smoke, debris) cross
in front of a hole.

## Degradation ladder

Capture, physics, surface shading, post-FX, live mode and audio all fail independently and
silently — the engine runs on a bare 2D canvas in the worst case. See the
[fallback table](./api.md#fallback-behaviour).
