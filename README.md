# desktop-destroyer

Desktop Destroyer for the web — a nostalgic, fully procedural canvas overlay that lets visitors smash, shoot, burn, soak, saw, paint, and then sweep up any page. Inspired by the classic Windows "Desktop Destroyer" stress-relief toy.

- **Destroys the real page** — inspired by [canvasui.dev](https://canvasui.dev)'s html-in-canvas approach: on activation the live DOM is rasterized into a destructible canvas (via `html-to-image`'s foreignObject technique — no experimental browser flags) and the real DOM is hidden with `visibility` so layout and scrolling survive. Bullets punch transparent holes through the actual content revealing the void behind the page, fire erodes content pixels away with charred rims, the hammer knocks tumbling shards of real page content loose, and the chainsaw severs text mid-word. A pristine snapshot is kept so the broom and repair genuinely restore content.
- **Zero assets** — every decal, flame, cursor, and sound is generated at runtime (Canvas 2D + WebAudio).
- **Real interactions** — fire spreads on its own and eats the page; water actually puts it out (with steam); the broom repairs damage from the snapshot.
- **Framework-agnostic core** with a drop-in React component.
- **Graceful fallback** — if the page capture fails (e.g. CORS-tainted resources), damage falls back to an overlay layer; `dispose()` removes every trace and restores the page.

## Tools

🔨 Hammer (crack webs) · 🔫 Pistol (bullet holes) · 🎯 Machine gun (hold to spray) · 🔥 Flamethrower (fire spreads + scorches) · 💦 Water hose (douses fire) · 🪚 Chainsaw (drag to tear gashes) · 🎨 Paintball (splatters) · 🧹 Broom (cleans damage)

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

Props: `onClose`, `tools` (replace/extend the toolset), `soundDefault` (default `false`), `engineOptions` (`zIndex`, `maxFlames`, `maxParticles`, `target`, `captureMode`, …).

Keyboard: `1`–`8` select tools, `Esc` deselects then closes.

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

Engine API available to tools: `spawnParticle`, `spawnFlame`, `dowseFlames`, `eraseDamage`, `shatter`, `shake`, `clear`, `sound`, `surfaceCtx` (paint decals here — targets the destructible content when live), `content` (`punch` / `burn` / `cut` / `char` / `restore` — null until the capture is ready), `fxCtx`, `flames`, `width`, `height`.

Engine options: `captureContent` (default `true`) toggles the real-content pipeline; `contentRoot` chooses what gets captured (default `document.body`); `captureFilter` decides which nodes make it into the snapshot; `captureMode` picks the rasterizer (see [Live mode](#live-mode-experimental)).

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

Destruction is preserved across refreshes: in live mode the content layer keeps the freshly captured page (`base`) separate from the holes and char marks (`wounds` / `decals`) and recomposites them on every refresh. All tools behave identically in both modes.

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

Live mode mirrors a pruned **clone** of the capture root into an offscreen `<canvas layoutsubtree>`, because `drawElementImage()` only accepts immediate children of such a canvas — there is no way to point it at the live page. So it is best described as *instant re-capture*, not live DOM. The clone's CSS animations are frozen to the live element's current values, and the page backdrop is recomposited, so the result matches the page; but `position: fixed` descendants resolve against the mirror, and canvas/form/scroll state inside the subtree isn't cloned.

Full research notes, the measured constraints, and the reasoning behind this design are in [HTML-IN-CANVAS.md](./HTML-IN-CANVAS.md).

## License

MIT
