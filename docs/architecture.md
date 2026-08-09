# Architecture

How the package turns a live page into a destructible object. Deeper dives:
the [README](../README.md) covers the design reasoning per feature, and
[HTML-IN-CANVAS.md](../HTML-IN-CANVAS.md) is the research log behind live capture mode.

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

## Module map

```
src/
├── engine.ts        DestroyerEngine — DOM, rAF loop, input, particles, flames,
│                    bugs, frost/fuel grids, singularity, collapse, shake, quality
├── types.ts         The full public type surface (DestroyerOptions, Tool, …)
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
├── topology.ts      Material connectivity: detached-region detection, stroke↔material
│                    clipping (the only unit-tested module — tests/topology.test.mjs)
├── elements.ts      Pre-capture DOM measurement for demolition/collapse
├── textmask.ts      Text-line mask so refraction backs off over glyphs
├── decals.ts        Procedural persistent marks (cracks, holes, scorch, frost, splats…)
├── sprites.ts       Lazily-baked gradient sprites for the hot particle paths
├── tools.ts         Hammer, gun, flamethrower, hose, chainsaw, paintball, broom
├── heavy-tools.ts   Demolition, rocket, lightning, freeze ray, black hole, bugs
├── toolart.ts       Hand-drawn pseudo-3D tool renderings + toolbar icon baking
├── cursors.ts       emojiCursor()
├── audio.ts         SoundEngine — fully procedural WebAudio
├── performance.ts   Quality profiles, device detection, frame telemetry ring
├── share.ts         Blob download / clipboard helpers
└── react/           DesktopDestroyer component + toolbar
```

## The frame loop

The engine schedules **no animation frames while idle** — pointer input, scrolling, capture
completion, tool selection and new entities wake it on demand.

```
frame:
  update   tool.tick → collapse → flames → bugs → singularity → particles → physics
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
