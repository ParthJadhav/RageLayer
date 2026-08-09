# desktop-destroyer

Desktop Destroyer for the web — a nostalgic, fully procedural overlay that lets visitors smash, shoot, burn, soak, saw, paint, freeze, bomb, and then sweep up any page. Inspired by the classic Windows "Desktop Destroyer" stress-relief toy.

![A mixed destruction session on the demo page](./docs/screenshots/aftermath.png)

```sh
npm install desktop-destroyer            # npm registry (once published)
npm install github:ParthJadhav/desktop-destroyer   # straight from the repo
```

**Docs:** [Getting started](./docs/getting-started.md) ·
[Integrations](./docs/integrations.md) (React, Next.js, Vue, Svelte, Astro, vanilla) ·
[API reference](./docs/api.md) ·
[Tool gallery](./docs/tools.md) (screenshots) ·
[Architecture](./docs/architecture.md) ·
[Performance](./docs/performance.md) ·
[Contributing](./CONTRIBUTING.md)

**Try it:** `bun install && bun run build`, serve the repo root with any static server, and
open `/demo/` — a complete destructible page with a vanilla toolbar.

- **Destroys the real page** — inspired by [canvasui.dev](https://canvasui.dev)'s html-in-canvas approach: on activation the live DOM is rasterized into a destructible canvas (via `html-to-image`'s foreignObject technique — no experimental browser flags) and the real DOM is hidden with `visibility` so layout and scrolling survive. Bullets punch transparent holes through the actual content revealing the void behind the page, fire erodes content pixels away with charred rims, and the chainsaw severs text mid-word. A pristine snapshot is kept so the broom and repair genuinely restore content.
- **Real rigid-body physics** — struck regions don't just vanish, they *come off*. A hand-rolled sequential-impulse solver ([`physics.ts`](./src/physics.ts)) turns them into convex bodies carrying their own slice of the page, which tumble, collide with each other, and pile up at the bottom of the window.
- **DOM-aware demolition** — before the page is hidden, every heading, paragraph, image and card is measured ([`elements.ts`](./src/elements.ts)). The demolition tool knocks a *whole element* loose as one object, and `collapse()` brings the visible page down element by element in a wave.
- **The page itself is a shader** — following [canvasui.dev](https://canvasui.dev)'s architecture, the 2D content canvas is demoted to a source texture and a WebGL2 canvas takes its place in the DOM ([`surface.ts`](./src/surface.ts)). The surface's alpha channel *is* the wound field, so its gradient across a tear gives a normal for free: torn edges refract the page behind them, fringe with chromatic dispersion, and catch the light instead of reading as flat cutouts. An undamaged page is bit-identical to the raster, and holes keep an exact silhouette. See [Surface shading](#surface-shading).
- **WebGL post-processing** — the effects layer runs through bloom, heat-haze refraction and chromatic aberration ([`postfx.ts`](./src/postfx.ts)). Skipped entirely, with no visual dependency on it, when WebGL is unavailable.
- **Zero assets** — every decal, flame, shard, cursor, and sound is generated at runtime (Canvas 2D + WebGL + WebAudio). The only dependency is `html-to-image`.
- **Real interactions** — fire spreads on its own and eats the page; water puts it out; frost stops fire catching at all and makes the page shatter like glass; a singularity eats page, debris and particles alike, then detonates when you let go.
- **Framework-agnostic core** with a drop-in React component.
- **Graceful fallback** — if the page capture fails (e.g. CORS-tainted resources), damage falls back to an overlay layer; `dispose()` removes every trace and restores the page.

## Tools

| | | |
|---|---|---|
| 🔨 **Hammer** | click | Each spot takes 1–4 escalating blows — dent, spreading cracks, deep splintering — before it fractures into falling debris |
| 🔫 **Gun** | click / hold | A click fires one aimed round; holding the trigger goes full-auto with spray, barrel smoke and casings |
| 🔥 **Flamethrower** | hold | Fire catches, burns, deepens, then breaks through to the void; it spreads on a wood-fuel field, melts frost into steam, and dies where the page is already gone |
| 💦 **Water hose** | hold | A pressurized stream that arcs like a real hose; douses fire, washes stains off the page, flushes bugs away, leaves runs down the page |
| 🪚 **Chainsaw** | drag | Tears gashes and strips — close a loop and the enclosed piece drops out whole |
| 🎨 **Paintball** | click | Splatters that drip and dry |
| 🏗️ **Demolition** | click / drag | Knock real page elements off as rigid objects |
| 🚀 **Rocket launcher** | click | Launches from the shoulder tube at the cursor — backblast, arc out, guidance back onto the mark — then a blast that fractures and ignites |
| ⚡ **Lightning** | click | Forking bolt with sub-branches and restrike flicker, ionized burn channel, ground crawlers, crater, fires |
| ❄️ **Freeze ray** | hold | Frost that resists fire, slows bugs until they freeze solid, and shatters like glass |
| 🕳️ **Black hole** | hold | Gravitationally lenses the page (thin-lens 1/r deflection, frame-dragging swirl, photon ring, opaque horizon), rips elements loose, and pulls debris in on an inverse-square law; collapses into an explosion on release |
| 🐛 **Bug** | click | Release a bug that wanders and gnaws trails through the page. It lives in the engine, so it keeps eating while you switch tools — and any tool kills it: squash it, shoot it, burn it, blow it up, or feed it to a black hole |
| 🧹 **Broom** | drag | Sweeps damage away, repairs content, swats bugs |

Plus 💥 collapse the whole page, 📸 save a PNG of the wreckage, 🩹 repair everything.

### The void

Where the page has been destroyed there is *nothing* — and every tool treats it that way. A hammer swung at a hole whiffs through empty air; a round fired into one sails through (tracer, casing, and bang, but no impact); a paintball vanishes without a splat; the chainsaw spins free with nothing to bite; a rocket aimed at a hole flies straight through it and is gone; lightning doesn't ground — light and thunder, no crater; frost, paint and every other decal clip themselves to surviving page pixels, so a splat across a hole's rim paints the rim and loses the rest to the dark. Only airborne things — smoke, debris, a passing bolt — cross in front of a hole. Custom tools get the same physics via `engine.onPage(x, y)` / `engine.pageOpacityAt(x, y)`.

### Cause and effect

The elements interact the way you'd expect them to, in both directions:

- **Fire vs ice.** Frost refuses to ignite — flame seeds fizzle into steam on iced page — but heat wins with persistence: an established blaze steadily melts the rime around it, and the flamethrower's jet strips frost off the page ahead of the nozzle so a frozen patch can be thawed and then burned.
- **Water cleans, the broom repairs.** The hose washes stains — paint, soot, smears, rime — off surviving page, gradually, under sustained spray. It never rebuilds structure: holes stay holes. Full repair (content restored from the pristine snapshot) belongs to the broom alone. Custom tools get both verbs: `engine.washSurface(x, y, r, strength)` and `engine.eraseDamage(x, y, r)`.
- **Bugs live in the ecosystem.** Fire burns them, blasts and fractures crush them, black holes swallow them — and now cold slows them down until heavy rime freezes them solid (they come apart as ice, no smear), water carries them off the page (`engine.flushBugs`), and the broom swats them flat.
- **Effects follow the tool.** Directional effects read `engine.toolAim` — the smoothed direction the drawn tool is pointing — so the gun's tracer, ricochet and ejected casings line up with its barrel, and a rocket leaves the launcher's tube along its axis (backblast out the rear, recoil the other way) before guidance curves it back onto the click point.

## React

```tsx
import { DesktopDestroyer } from "desktop-destroyer/react";

function App() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Destroy this page</button>
      {open && <DesktopDestroyer onClose={() => setOpen(false)} />}
    </>
  );
}
```

Props: `onClose`, `tools` (replace/extend the toolset), `soundDefault` (default `false`), `engineOptions` (`zIndex`, `maxFlames`, `maxParticles`, `physics`, `gravity`, `postFX`, `harvestElements`, `target`, `captureMode`, …).

Keyboard: `1`–`9`/`0` select tools, `X` collapse, `P` save a picture, `R` repair, `M` mute, `Esc` deselects then closes.

## Vanilla / any framework

```ts
import { DestroyerEngine, defaultTools } from "desktop-destroyer";

const engine = new DestroyerEngine({ soundEnabled: true });
for (const tool of defaultTools) engine.registerTool(tool);
engine.setTool("flamethrower"); // null to make the overlay click-through
engine.clear();                 // repair everything
engine.dispose();               // remove the overlay entirely
```

## Custom tools

A tool is a small object drawing onto two canvases — `damageCtx` (persistent) and `fxCtx` (per-frame) — plus the particle/flame systems:

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
};
```

### Drawn tool art

Every built-in tool carries `art` — a hand-drawn pseudo-3D rendering (shaded
canvas vectors, still zero assets) that follows the pointer in place of the CSS
cursor and animates from live state: the hammer swings on click, the gun
recoils and cycles its slide, the chainsaw's chain crawls while cutting. Give a
custom tool one by setting `art: (ctx, state) => void`; the canvas origin is
the pointer hotspot, and `state` carries the clock, held flag, seconds since
press/release, and smoothed pointer velocity/aim (see `ToolArtState`). Tools
without `art` fall back to their CSS `cursor`. `toolIconDataUrl(art, size)`
bakes any art function into a toolbar icon; the bundled React toolbar does this
automatically.

Prefer the classic look? Set `toolStyle: "emoji"` and every tool goes back to
its emoji CSS cursor and emoji toolbar icon, with `art` ignored:

```tsx
// React — one prop drives the pointer art and the toolbar icons together.
<DesktopDestroyer toolStyle="emoji" />

// Engine — same option at the engine level.
new DestroyerEngine({ toolStyle: "emoji" });
```

The default is `"3d"`.

Engine API available to tools:

- **Surfaces** — `surfaceCtx` (paint decals here; targets the destructible content when live), `fxCtx`, `content` (`punch` / `burn` / `cut` / `char` / `restore`, null until the capture is ready), `width`, `height`, `onPage(x, y)` / `pageOpacityAt(x, y)` (whether the page still exists at a point — consult before doing surface work, and do nothing into the void).
- **Effects** — `spawnParticle`, `spawnFlame`, `dowseFlames`, `flames`, `shake`, `heat`, `sound`.
- **Physical destruction** — `fracture(x, y, r, opts)` shatters a disc of page into rigid bodies; `explode(x, y, r, opts)` adds the blast, fireball and fires; `demolish(x, y)` knocks the real element under the cursor loose; `collapse()` brings the visible page down; `freeze` / `frostAt`; `setSingularity` / `singularity`; `physics` (the world itself).
- **State** — `eraseDamage`, `clear`, `pageElements`, `snapshot()`.

Engine options: `captureContent` (default `true`) toggles the real-content pipeline; `contentRoot` chooses what gets captured (default `document.body`); `captureFilter` decides which nodes make it into the snapshot; `captureMode` picks the rasterizer (see [Live mode](#live-mode-experimental)); `physics` / `gravity` / `postFX` / `harvestElements` turn off the heavy machinery independently; `quality` selects `"auto"` (default), `"high"`, `"balanced"`, or `"low"`.

## Physics

Chunks of page are convex polygons with a pre-baked, alpha-masked sprite of the pixels they were cut from, so drawing one costs a single rotated `drawImage` — the same as a particle, for something that behaves like an object. The solver is the textbook sequential-impulse shape: SAT for the axis of least penetration, reference/incident face clipping for up to two contact points, accumulated normal + Coulomb friction impulses over 8 iterations, then Baumgarte position correction with a slop so resting stacks don't jitter. Bodies sleep when they settle, which is what keeps a hundred-piece heap free.

Two deliberate choices worth knowing about:

- **The floor is the bottom of the window, not the document.** On a page ten screens tall, debris that fell to the document floor would be somewhere you are not looking. Scrolling drags the floor through the heap and wakes it.
- **Chunk textures come from the *visible* content canvas, not the pristine snapshot.** A shard broken off a scorched, half-burnt region carries that damage down with it.

```ts
engine.fracture(x, y, 60, { power: 240 });        // shatter a disc into debris
engine.explode(x, y, 96, { power: 700 });         // …plus blast, fireball, fires
engine.demolish(x, y);                            // knock a real element loose
engine.collapse();                                // bring the visible page down
engine.physics.blast(x, y, 300, 500);             // shove the existing heap
```

Frozen regions behave differently on purpose: `freeze()` writes to a coarse document-wide frost grid, `spawnFlame` refuses to light where the grid is high, and `fracture` reads it to produce more, lighter, blue-tinted shards with a higher restitution — ice skitters where paper flops.

## Surface shading

The destructible page is not presented as a 2D canvas. That canvas becomes a **source texture** and a WebGL2 canvas ([`surface.ts`](./src/surface.ts)) takes its place in the DOM — the same split every [canvasui.dev](https://canvasui.dev) component uses, pointed at destruction instead of decoration.

There is no separate wound buffer. The surface's **alpha channel** already is one — 1 where the page survives, 0 where a tool took it away — and its gradient across a tear gives a surface normal, which drives the three things a flat cutout is missing:

| Term | What it does |
| --- | --- |
| `refraction` | Pixels near a tear sample the page slightly off-centre along the gradient, so the lip of a hole bends what is behind it. |
| `dispersion` | That offset is scaled per channel, fringing the lip. |
| `relief` / `rim` | The normal is lit, so one side of every tear falls into shadow — the cue that reads as thickness rather than deleted pixels. |
| `charEdge` | Fibre shadow hugging the surviving side of a cut. |
| `edge` | Gradient sample radius in device px. Wider reads as thicker material. |
| `depth` | Material thickness in CSS px (default 6). Inside every hole the cut side of the slab is rendered below the top edge — wood tone, grain — so the page reads as a board, not paper. Debris chunks carry a matching underside sprite. 0 restores the flat look. |

```ts
new DestroyerEngine({
  surface: { refraction: 3.2, dispersion: 0.5, rim: 1.2 },
  textMask: true, // default
});

new DestroyerEngine({ surface: false }); // mount the 2D canvas raw
```

`surface: false` turns shaded presentation off outright, the same way `postFX: false` does for the effects layer. It's the quickest way to tell whether a rendering problem is coming from this shader: if it still looks wrong with the shader off, it isn't.

Two properties are load-bearing, and `harness.html` covers both:

- **An undamaged page is bit-identical to the raster.** Every term scales with the alpha gradient, which is zero across intact page, and the quad samples at exact texel centres. None of the [capture fidelity](#capture-fidelity) work is undone by presenting through GL.
- **The silhouette stays exact.** Output alpha is the *unrefracted* sample, so a refracted colour never drags opaque pixels into a hole.

Cost is bounded by dirty rectangles on both sides — `texSubImage2D` uploads only the region a tool touched, `gl.scissor` restricts the raster to the same region. Tools drawing straight into `engine.surfaceCtx` are invisible to the layer, so a disc around the cursor is re-shaded every frame a tool is held; marks landing further out (paint splashes, lightning channels) call `engine.markSurface(x, y, radius)`.

`textMask` maps the page's text lines at capture time (`Range.getClientRects()`, quarter-res) so refraction backs off over glyphs — type near a tear reads as cut rather than smeared.

If WebGL2 is unavailable, refuses to link, or the page exceeds `MAX_TEXTURE_SIZE`, the 2D canvas is mounted directly and everything behaves as it did before. `ContentLayer.shaded` reports which path is live.

## Post-processing

The 2D effects canvas is demoted to an offscreen source and a WebGL canvas takes its place in the DOM. Each frame: a bright pass into a quarter-resolution buffer, two separable Gaussian blurs ping-ponging between two targets, then a composite that samples the effects layer through a heat-haze UV offset and a radial chromatic split before adding the bloom. The heat field is a tiny 2D canvas that flames stamp blobs into, so the shimmer costs the same whether one fire is burning or forty.

Bloom weight scales with what is actually on screen, and the blur passes are skipped outright at zero — an idle page with two paint splats pays nothing. If the context is missing or a program fails to link, `PostFX.available` stays false and the engine puts the plain 2D canvas back; nothing else in the engine knows the difference.

The fx and heat canvases are uploaded with `UNPACK_FLIP_Y_WEBGL`, because a 2D canvas starts at the top row and a GL texture starts at the bottom. Flipping at upload keeps the bright/blur passes — which read FBOs that GL rendered, and are already bottom-up — in the same orientation as the canvas sources, so the composite needs no per-input special case.

## Performance measurement and adaptive quality

Runtime measurement is built into the engine and enabled by default. It records
the rendered cadence and main-thread cost separately, with p50/p95/p99/max
values, plus update, surface, Canvas render, and post-FX timing. Each snapshot
also carries entity counts, capture duration, long/dropped-frame estimates,
pixel ratio, active quality tier, and Chrome heap figures when the browser
exposes them.

```ts
const engine = new DestroyerEngine({
  quality: "auto",
  performance: {
    sampleIntervalMs: 1000,
    onSample(sample) {
      console.table({
        fps: sample.fps,
        cpuP95: sample.cpu.p95,
        update: sample.breakdown.updateMs,
        render: sample.breakdown.renderMs,
        postFX: sample.breakdown.postFXMs,
        quality: sample.quality,
      });
    },
  },
});

engine.performanceSnapshot; // latest sample
const off = engine.onPerformance((sample) => sendToYourRUM(sample));
off();
```

`quality: "auto"` starts from `navigator.hardwareConcurrency` and
`navigator.deviceMemory`, then uses sustained measured frame cost to move among
three profiles. The balanced profile bounds a high-refresh display to a smooth
60 updates per second and reduces invisible overdraw. The low profile also
reduces solver iterations and falls back to the direct 2D effects canvas. Five
consecutive samples with ample headroom move quality back up, so a temporary
explosion does not permanently lower fidelity. Set an explicit tier to disable
adaptation while keeping telemetry, or pass `performance: false` to disable both
telemetry and automatic changes.

The engine schedules no animation frames while it is idle. Pointer input,
scrolling, capture completion, tool selection, and new simulation entities wake
it on demand.

### Repeatable Chrome benchmark

The package includes a network-free CDP suite covering idle, 1,200 particles,
32 fires, 170 rigid bodies, and a mixed stress case at 1280×720:

```sh
bun run benchmark          # native CPU
bun run benchmark:low-end  # Chrome at 6× CPU throttling
bun run memory:check       # 80 mixed create/work/dispose cycles with forced GC
```

The JSON output contains browser task/script/layout/style time, rAF
percentiles, long tasks, heap change, entity counts, and the engine's own phase
breakdown. Override `DD_CHROME_PATH` when Chrome is not installed in the macOS
default location; the runner also accepts `--cpu`, `--duration`, `--warmup`,
and `--scenarios`.

The memory gate warms one-time caches, forces garbage collection after every
20 cycles, and fails on retained DOM nodes, documents, listeners, layout
objects, canvas backing stores, simulation entities, tools, or performance
callbacks. It also bounds post-GC JavaScript heap growth to catch regressions
that are not visible in the DOM counters.

## Capture fidelity

The snapshot is meant to be indistinguishable from the live page, so the capture does three things beyond handing the root to `html-to-image`:

- **Backdrop recovery.** CSS propagates the *root* background to the viewport canvas, and the element it came from then paints nothing inside its own box. Rasterizing a subtree therefore loses the page background, and the result composites over the destroyer's dark void as a washed-out overlay. `resolvePageBackdrop()` walks `<html>` → `<body>` → root for the first opaque `background-color` (plus a gradient/texture `background-image` the root doesn't paint itself) and composites it under the snapshot.
- **Seam-free placement.** The snapshot is rasterized over the root's own *margin* box and blitted at that box's document offset (`measureCapture()`), instead of assuming the root fills `documentElement.clientWidth` from x=0. Body margins, centered `max-width` shells and reserved scrollbar gutters would otherwise leave an unpainted strip along one edge. Using the margin box (rather than the border box) also keeps `position: fixed` descendants — sticky navs, grain overlays — resolved against the same origin they use on the live page.
- **Dev tooling excluded.** `html-to-image` walks *open* shadow roots, so framework dev overlays get cloned into the snapshot and freeze there. `defaultCaptureFilter()` drops nodes carrying `data-dd-ignore`, custom elements whose tag matches `DEV_TOOL_ELEMENT_PREFIXES` (`nextjs-`, `next-route-announcer`, `vite-error-overlay`, `astro-dev-toolbar`, …), and — generically — any custom element that owns a shadow root while occupying no layout space, which is how dev tooling mounts out-of-flow chrome. Real custom elements that take up space (charts, tickers) are kept.

All three are host-agnostic. Pass your own `captureFilter` to change what is excluded — compose with `defaultCaptureFilter` if you only want to add exclusions:

```tsx
import { defaultCaptureFilter } from "desktop-destroyer";

<DesktopDestroyer
  engineOptions={{
    captureFilter: (node) => defaultCaptureFilter(node) && !node.classList?.contains("my-widget"),
  }}
/>;
```

If the capture fails (CORS-tainted resources, a font that won't embed), the engine logs a warning and falls back to overlay-only damage with the real page left visible.

## Live mode (experimental)

By default the page is rasterized **once**, with `html-to-image`, and frozen for as long as the toy is open. Chrome's experimental [HTML-in-Canvas API](https://github.com/WICG/html-in-canvas) can do the same job in ~6 ms instead of 0.5–2 s, which is cheap enough to re-capture the page about once a second — so the page keeps *living* underneath the destruction (a clock keeps ticking, a feed keeps updating) until you destroy that region.

```ts
new DestroyerEngine({
  captureMode: "auto",   // "auto" (default) | "snapshot" | "live"
  liveRefreshMs: 1000,   // live only; 0 = refresh on demand instead
});
```

| `captureMode` | Behaviour |
| --- | --- |
| `"auto"` *(default)* | Live when the browser exposes the API, snapshot otherwise. On any browser without the flag this is byte-for-byte the old behaviour. |
| `"snapshot"` | Always `html-to-image`. Works everywhere. |
| `"live"` | Require the experimental API. If it's missing — or the first live capture throws — the engine warns, sets `liveUnavailable`, and falls back to snapshot. |

**Enabling it.** Live mode needs Chromium 147+ with `chrome://flags/#canvas-draw-element` (or `chrome://flags/#enable-experimental-web-platform-features`) turned on. There is no polyfill; every other browser gets the snapshot path, which is why `"auto"` is the default.

Destruction is preserved across refreshes: in live mode the content layer keeps the freshly captured page (`base`) separate from the holes and char marks (`wounds` / `decals`) and recomposites them on every refresh. Decals that tools paint imperatively through `engine.surfaceCtx` (crack webs, gashes, splats, frost) are teed into the decals buffer at the context level, so they persist across refreshes too — without any tool knowing the buffer exists. Refreshes are scoped to the visible band plus a screen either side; below-the-fold pixels keep the previous (still pristine) refresh until scrolling brings them near. All tools behave identically in both modes.

**Repaint instead of re-clone.** The DOM clone is ~90% of a refresh (≈5 ms of the ≈6 ms). Where the browser also exposes `canvas.onpaint` / `requestPaint()` — canvas-ui's mechanism — the mirror is mounted **once** and refreshed with a bare `drawElementImage`, and its animations are left running with their clocks synced to the page's rather than frozen to the capture instant. `supportsPaintEvents()` reports whether that path is available; any failure inside it (a stale paint record after a reflow) falls back to re-cloning rather than losing the page. Note that a refresh still recomposites and re-uploads at document size, so this raises the ceiling on `liveRefreshMs` without making it free.

```ts
engine.captureStatus;    // "idle" | "capturing" | "snapshot" | "live"
engine.captureMode;      // what was requested
engine.liveUnavailable;  // live was asked for, the API wasn't there
engine.refreshContent(); // force a re-capture now (live only)
engine.on("statuschange", () => { /* … */ });
```

### Status chip

Capture used to happen silently. The React toolbar now floats a small status chip above itself: a spinner and **Capturing page…** while rasterizing, then the mode it settled on — **Live** (green dot) or **Snapshot** (neutral dot), or **Snapshot (live unavailable)** if live was requested and missing. Each carries a `title` explaining what that means and, for the fallback, which Chrome flag to turn on. The chip is marked `data-dd-ignore`, so it never ends up baked into the capture.

Using the engine directly instead of the React wrapper? Drive your own UI from `captureStatus` plus the `"statuschange"` event.

### Caveats

Live mode mirrors a pruned **clone** of the capture root into an offscreen `<canvas layoutsubtree>`, because `drawElementImage()` only accepts immediate children of such a canvas — there is no way to point it at the live page. So it is best described as *instant re-capture*, not live DOM. The clone's CSS animations are either frozen to the live element's current values (re-clone path) or run with their clocks synced to it (repaint path), and the page backdrop is recomposited, so the result matches the page; but `position: fixed` descendants resolve against the mirror, and canvas/form/scroll state inside the subtree isn't cloned.

The repaint path is written from the WICG IDL and canvas-ui's usage rather than measured — no browser available during development exposed `requestPaint`. Run Chrome with `--enable-blink-features=CanvasDrawElement` before relying on it.

Full research notes, the measured constraints, and the reasoning behind this design are in [HTML-IN-CANVAS.md](./HTML-IN-CANVAS.md).

## License

MIT
