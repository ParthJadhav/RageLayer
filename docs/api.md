# API reference

Eleven entry points:

- `desktop-destroyer` — the framework-agnostic engine, tools, and every building block
- `desktop-destroyer/engine` — engine + public contracts, without built-in tool models
- `desktop-destroyer/tools` — seven everyday tools
- `desktop-destroyer/tools/heavy` — six cinematic/physics-heavy tools
- `desktop-destroyer/tools/advanced` — six interaction-focused tools
- `desktop-destroyer/lazy` — asynchronous base/heavy/advanced/complete tool loaders
- `desktop-destroyer/loadouts` — named and custom loadout helpers
- `desktop-destroyer/sdk` — typed custom-tool factories and utilities
- `desktop-destroyer/react` — toolbar component and headless hook
- `desktop-destroyer/vue` — lifecycle-safe Vue composable
- `desktop-destroyer/svelte` — Svelte action and lifecycle controller

Everything is fully typed; this page covers the surfaces you'll actually reach for. For the
exhaustive list, see [`src/index.ts`](../src/index.ts) and [`src/types.ts`](../src/types.ts).

## Lifecycle helpers

For most custom integrations, start with the lazy controller:

```ts
import { createDesktopDestroyer } from "desktop-destroyer";

const destroyer = createDesktopDestroyer({
  initialTool: "hammer",
  tools: myTools, // defaults to defaultTools
});

destroyer.open();
destroyer.engine; // DestroyerEngine | null
destroyer.isOpen;
destroyer.toggle();
destroyer.close();
destroyer.subscribe((engine) => console.log(engine));
```

`createDesktopDestroyer()` is SSR-safe because it stays lazy. `mountDesktopDestroyer(options)`
registers the tools and returns a live engine immediately, so call it only in a browser. Construct
`DestroyerEngine` directly when you want to register each tool yourself.

## `new DestroyerEngine(options?)`

Creates the overlay and starts capturing the page. Must run in a browser.

### `DestroyerOptions`

| Option | Type | Default | |
|---|---|---|---|
| `target` | `HTMLElement` | `document.body` | Where the overlay container is appended |
| `zIndex` | `number` | `2147483000` | Overlay stacking position |
| `soundEnabled` | `boolean` | `false` | Procedural WebAudio effects |
| `reducedMotion` | `boolean \| "system"` | `"system"` | Follow the OS preference or explicitly disable/enable camera shake |
| `toolStyle` | `"3d" \| "emoji"` | `"3d"` | Drawn tool art vs. emoji CSS cursors |
| `toolScale` | `number` | `1` | Procedural model scale, clamped to 0.5–2 |
| `pauseWhenHidden` | `boolean` | `true` | Suspend simulation, animation, and looped audio in background tabs |
| `quality` | `"auto" \| "high" \| "balanced" \| "low"` | `"auto"` | Adaptive quality tier (see [performance](./performance.md)) |
| `performance` | `boolean \| PerformanceOptions` | `true` | Telemetry + adaptive quality |
| `maxParticles` | `number` | `1400` | Particle budget |
| `maxFlames` | `number` | `32` | Simultaneous fire budget |
| `physics` | `boolean` | `true` | Rigid-body debris |
| `gravity` | `number` | `1750` | px/s² for debris and particles |
| `postFX` | `boolean` | `true` | WebGL bloom / heat haze / chromatic aberration |
| `effectsPixelRatio` | `number` | `1` | Effects/tool-art backing resolution, clamped to `0.5..2` and device DPR |
| `surface` | `Partial<SurfaceParams> \| false` | on | WebGL surface shading of torn edges (`false` = raw 2D canvas) |
| `textMask` | `boolean` | `true` | Damp refraction over text lines |
| `harvestElements` | `boolean` | `true` | Measure page elements for demolition/collapse |
| `captureContent` | `boolean` | `true` | Rasterize the real page (off = overlay-only damage) |
| `captureMode` | `"auto" \| "snapshot" \| "live"` | `"auto"` | Snapshot by default; experimental live capture when the browser exposes it |
| `liveRefreshMs` | `number` | `1000` | Live-mode re-capture cadence (0 = on demand) |
| `contentRoot` | `HTMLElement` | `document.body` | What gets captured |
| `captureFilter` | `(node: Node) => boolean` | `defaultCaptureFilter` | Which nodes make it into the snapshot. Called for every cloned node (elements *and* text); return `true` for non-elements unless you mean to drop text |
| `materials` | `Iterable<MaterialDefinition>` | built-ins | Register custom material definitions before region scanning |
| `combos` | `boolean \| ComboTrackerOptions` | `true` | Cross-tool spatial interaction detection |
| `history` | `boolean \| HistoryOptions` | `false` | Bounded persistent-state undo/redo |

### Engine lifecycle & state

```ts
engine.registerTool(tool);      // add a Tool (see below)
engine.registerTools(toolset);  // bulk registration for split/lazy toolsets
engine.unregisterTool(id);      // safely release + remove one tool
engine.setTool("hammer");       // select by id; null = click-through overlay
engine.tool;                    // currently selected Tool | null
engine.getTools();              // registered tools in order
engine.setSound(true);
engine.pause();                 // preserve state without spending frame time
engine.paused;                  // includes automatic hidden-tab suspension
engine.resume();
engine.clear();                 // repair everything (page + damage + entities)
engine.undo() / engine.redo();  // when history is enabled
engine.checkpoint("label");     // explicit pre-script checkpoint
engine.historyState;            // bounded stack state
engine.collapse();              // bring the visible page down element by element
engine.snapshot();              // Promise<Blob> PNG of the wreckage
engine.dispose();               // remove every trace, restore the page

engine.captureStatus;           // "idle" | "capturing" | "snapshot" | "live"
engine.liveUnavailable;         // live requested but the API is missing
engine.refreshContent();        // force a live-mode re-capture
engine.on("statuschange", cb);  // also "toolchange", "pausechange", "historychange", …
engine.performanceSnapshot;     // latest PerformanceSnapshot
engine.onPerformance(cb);       // subscribe to telemetry; returns unsubscribe fn
```

## Custom tools

For stateful tools, prefer `defineTool()` from `desktop-destroyer/sdk`; it returns a factory so
multiple engines never share mutable tool state. The plain-object contract remains fully supported:

A `Tool` is a plain object drawing onto the engine's canvases:

```ts
import type { Tool } from "desktop-destroyer";

const stamp: Tool = {
  id: "stamp",
  name: "Stamp",
  icon: "🐾",
  hint: "click to stamp",
  onDown(engine, e) {
    engine.damageCtx.fillText("🐾", e.x, e.y);
    engine.shake(3);
  },
  // Optional: onMove, onUp, tick(engine, dt), cursor, art (see below),
  // reset() — clear any module-level state (in-flight projectiles, strike
  // sites). Called on registerTool, engine.clear() and engine.dispose().
};
```

Handlers receive the engine as `DestroyerEngineApi` — the full toolkit:

### Surfaces

| | |
|---|---|
| `surfaceCtx` | Persistent decal context targeting the destructible content |
| `fxCtx` | Per-frame effects context (cleared every frame) |
| `content` | `ContentApi` — `punch` / `burn` / `cut` / `char` / `restore` (null until capture is ready) |
| `width` / `height` | Overlay size in CSS px |
| `onPage(x, y)` / `pageOpacityAt(x, y)` | Does the page still exist there? Consult before doing surface work — the void swallows everything |
| `markSurface(x, y, r)` | Tell the surface shader a region changed outside the cursor |
| `materialAt(x, y)` / `materials` | Resolve or register physical material behavior |
| `signalInteraction(kind, x, y)` / `onCombo(cb)` | Participate in cross-tool combos |

### Effects

`spawnParticle(p)` · `spawnFlame(x, y, opts)` · `dowseFlames(x, y, r)` · `flames` ·
`shake(power)` · `heat(x, y, r, strength)` · `sound` (the `SoundApi`).

### Physical destruction

```ts
engine.fracture(x, y, 60, { power: 240 });  // shatter a disc into rigid debris
engine.explode(x, y, 96, { power: 700 });   // …plus blast, fireball, fires
engine.demolish(x, y);                      // knock the real element under the cursor loose
engine.collapse();                          // bring the whole visible page down
engine.freeze(x, y, r, strength);           // frost field (resists fire, shatters icy)
engine.frostAt(x, y);
engine.setSingularity(s) / engine.singularity;
engine.pullDebris(x, y, r, strength, dt);   // safe gravity-tool primitive
engine.launchDebris(x, y, r, dx, dy, speed);
```

The concrete `DestroyerEngine` also exposes its `PhysicsWorld` for low-level integrations; custom
tools typed against `DestroyerEngineApi` should use the bounded debris primitives above.

### State & repair

`eraseDamage(x, y, r)` (the broom's verb) · `washSurface(x, y, r, strength)` (the hose's verb —
cleans stains, never rebuilds structure) · `flushBugs(x, y, r)` · `clear()` ·
`pageElements` · `toolAim` (smoothed pointing direction — keeps directional effects lined up
with the drawn tool art).

### Drawn tool art

Give a tool `art: (ctx, state) => void` and it renders in place of the CSS cursor — the canvas
origin is the pointer hotspot, `state` carries the clock, held flag, time since press/release,
and smoothed velocity/aim (`ToolArtState`). `toolIconDataUrl(art, size)` bakes the same art
into a toolbar icon. Tools without `art` fall back to their `cursor` / `emojiCursor(emoji)`.
Built-ins use exact measured silhouette bounds; custom models use an alpha-scan fallback. See the
[model guide](./models.md).

## Lower-level building blocks

All exported for reuse without the engine:

- **Physics** — `PhysicsWorld`, `Body`, `MAX_BODIES`: a 2D sequential-impulse solver
  (SAT, contact clipping, friction, sleeping) with nothing destroyer-specific in it.
- **Fracture** — `voronoiCells`, `gridCells`, `convexHull`, `bakeChunk`, `makeChunk`,
  `shardBudget`: impact-biased Voronoi shattering and chunk-sprite baking.
- **Decals** — `drawCrack`, `drawBulletHole`, `drawScorch`, `drawFrost`, `drawGash`,
  `drawSplat`, `drawPaintStreak`, `drawBurnChannel`, `PAINT_COLORS`, `randomPaint`.
- **Capture** — `defaultCaptureFilter`, `measureCapture`, `resolvePageBackdrop`,
  `DD_IGNORE_ATTR`, `DEV_TOOL_ELEMENT_PREFIXES`, `supportsLiveCapture`, `supportsPaintEvents`.
- **Rendering** — `SurfaceRenderer`, `PostFX`, `createProgram`, `createQuad`, `createTexture`,
  `clearSpriteCache` (drop the shared baked-sprite atlas; rebuilt lazily on next use — the
  engine already calls it when the last engine is disposed).
- **Page mapping** — `harvestElements`, `elementAt`, `elementsInBand`, `buildTextMask`.
- **Sharing** — `downloadBlob(blob, filename)`, `copyBlobToClipboard(blob)` (resolves `false`
  when the browser refuses), `snapshotFilename(ext?)`: the helpers the React toolbar uses to
  save `engine.snapshot()` output, exported for hosts building their own toolbar.

## Noticing degradation

None of the fallbacks below throw — that is the point of them — so a host that wants to know when
visitors are getting a reduced experience has to be told. `onError` is that channel:

```ts
mountDesktopDestroyer({
  onError(error) {
    // scope: "capture" | "live-capture" | "live-refresh"
    //      | "element-harvest" | "text-mask" | "page-height"
    reportToMonitoring(error.scope, error.message, error.cause);
  },
});
```

The same reports are available after the fact and by subscription:

```ts
engine.error;                       // the most recent EngineError, or null
engine.onError((error) => { ... }); // returns an unsubscribe function
engine.on("error", () => { ... });  // for adapters that only need to re-render
```

Pass `onError` as an option rather than subscribing afterwards when you care about capture failure:
capture starts inside the constructor, so a handler attached later misses it.

Registering any handler suppresses the matching `console.warn`, so a host that forwards these to
its own logging does not see every failure twice. With no handler the warnings behave exactly as
they always have.

## Keyboard operation

- `engine.strike(x, y, { holdMs? })` — use the active tool at a document point with no pointer
  device. Runs the same `onDown`/`onUp` pair a click produces and takes a history checkpoint, so
  custom tools need no special handling to be keyboard-reachable. Returns `false` when no tool is
  selected or the engine is paused.
- `engine.setAim(point | null)` / `engine.aim` — the on-canvas aiming cursor, drawn in document
  space above the destruction.
- `engine.historyEnabled` — whether undo/redo was turned on, as distinct from whether there is
  currently anything to undo. A toolbar needs this to show its undo controls from the start.

See [Toolbars, i18n & keyboard](./toolbar.md) for the ready-made aiming UI.

## Fallback behaviour

Every heavy dependency degrades independently and silently:

| Missing | Behaviour |
|---|---|
| WebGL2 (surface) | 2D content canvas mounted directly — flat cutouts, everything else identical |
| WebGL (post-FX) | Effects canvas presented raw; no bloom/haze |
| Page capture fails (CORS taint, …) | Reported via `onError`; overlay-only damage, real page stays visible |
| `html-in-canvas` API (live mode) | Snapshot capture via `html-to-image` |
| WebAudio | Silence |
