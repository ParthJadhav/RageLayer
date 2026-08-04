# HTML-in-Canvas — research notes & live-mode design

Research done August 2026 against Chrome 149 (Playwright's `chromium_headless_shell-1228`,
`Chrome/149.0.7827.55`). Everything below marked **verified** was measured in that build, not
read off a blog post.

## 1. What the API actually is

The WICG proposal is [`WICG/html-in-canvas`](https://github.com/WICG/html-in-canvas). Chrome
shipped it behind a flag as of Chromium 147.

**The method is `drawElementImage()`, not `drawElement()`.** The proposal was renamed; a lot of
secondary write-ups (and the Chrome status entry title, "HTML in Canvas") still say `drawElement`.
**Verified:** in Chrome 149, `CanvasRenderingContext2D.prototype.drawElement` is `undefined` and
`CanvasRenderingContext2D.prototype.drawElementImage` is a `function`.

IDL, from the explainer:

```idl
partial interface HTMLCanvasElement {
  [CEReactions, Reflect] attribute boolean layoutSubtree;
  attribute EventHandler onpaint;
  void requestPaint();
  ElementImage captureElementImage(Element element);
  DOMMatrix getElementTransform((Element or ElementImage) element, DOMMatrix drawTransform);
};

interface mixin CanvasDrawElementImage {
  DOMMatrix drawElementImage((Element or ElementImage) element,
                             unrestricted double dx, unrestricted double dy);
  DOMMatrix drawElementImage((Element or ElementImage) element,
                             unrestricted double dx, unrestricted double dy,
                             unrestricted double dwidth, unrestricted double dheight);
  // + sx/sy/swidth/sheight source-rect overloads
};

CanvasRenderingContext2D includes CanvasDrawElementImage;
OffscreenCanvasRenderingContext2D includes CanvasDrawElementImage;
```

Sibling entry points exist for WebGL (`texElementImage2D`) and WebGPU
(`copyElementImageToTexture`). We only need the 2D one.

### Enabling it

| Surface | Value |
| --- | --- |
| User-facing flag | `chrome://flags/#canvas-draw-element` ("Canvas Draw Element") |
| Also enabled by | `chrome://flags/#enable-experimental-web-platform-features` |
| CLI (verified, each works alone) | `--enable-experimental-web-platform-features`, `--enable-blink-features=CanvasDrawElement`, `--enable-features=CanvasDrawElement` |
| Origin trial | "HTML-in-Canvas", Chrome 148–150 |
| Browsers | Chromium 147+ (Chrome Canary, Brave Stable). No Firefox/Safari. |

Feature detection we use:

```ts
typeof (CanvasRenderingContext2D.prototype as ...).drawElementImage === "function"
```

### The hard constraint (verified)

`drawElementImage()` throws unless **all** of these hold:

1. The `<canvas>` carries the `layoutsubtree` attribute.
2. The element is a **direct child of that canvas**. Passing anything else throws:
   `TypeError: Failed to execute 'drawElementImage' on 'CanvasRenderingContext2D': Only immediate
   children of the <canvas> element can be passed to DrawElementImage.`
3. The element generated boxes **in the most recent rendering update**. Appending a child and
   drawing it in the same task throws
   `InvalidStateError: ... No cached paint record for element.` — you must let at least one
   frame go by first (we wait two `requestAnimationFrame`s).

There is no way to point it at arbitrary live page DOM. This is the single fact that shapes the
whole design.

### Tainting (verified — and it matters a lot here)

**The canvas is not tainted.** After `drawElementImage()`, `toDataURL()` and `getImageData()` both
succeed. The spec calls this "read-back-allowed rendering": rather than tainting, the renderer
*omits* things that would leak cross-origin or user state — cross-origin embedded content, visited
link styling, system colors, IME popups.

This is load-bearing for us: every destruction tool composites with `destination-out` /
`source-atop` and the broom reads back from a pristine copy. A tainted canvas would have killed
live mode outright.

### Scaling: `drawElementImage` device-scales the element itself (verified)

This one cost us a shipped bug, so it is worth stating precisely.

`drawElementImage()` rasterizes the element **at the host canvas's own device scale** — the ratio
between the canvas's backing store and its CSS size — and *then* applies the current transform. The
destination `dx`/`dy` are ordinary user-space coordinates, so under an identity transform they are
backing-store pixels.

Measured on Chrome 149 with a 100×50 CSS-px element inside a host canvas whose CSS size is 300×200:

| Canvas backing | CTM | Drawn size (device px) | Origin (device px) for `dx,dy = 10,20` |
| --- | --- | --- | --- |
| 300×200 (1×) | identity | 100×50 | 10, 20 |
| 600×400 (2×) | identity | **200×100** | 10, 20 |
| 600×400 (2×) | `setTransform(2,0,0,2,0,0)` | **400×200** | 20, 40 |
| 390×260 (1.3×) | identity | **130×65** | 10, 20 |
| 390×260 (1.3×) | `setTransform(1.3,…)` | **169×84.5** | 13, 26 |

The scale is a property of the *canvas*, not of `window.devicePixelRatio`: the numbers above are
identical whether the page runs at `deviceScaleFactor` 1 or 2.

The practical consequence: the usual "size the backing store by dpr, then `setTransform(dpr,…)` and
draw in CSS px" canvas idiom is **wrong** here. It double-scales, by exactly `dpr`. On a 1× display
that multiplies by 1 and is invisible, which is why it survived every headless test; on a retina
display it is a 2× zoom. Draw under an identity transform with device-pixel coordinates instead.

The returned `DOMMatrix` is not the transform that was used — for the 2× rows above it comes back as
`[1,0,0,1,5,10]` and `[2,0,0,2,60,45]` respectively. We do not rely on it.

### One more surprise (verified)

Chrome only keeps a paint record for a canvas subtree if the canvas is **actually being painted**.
Measured, drawing a clone of `document.body` into a host canvas:

| Host canvas style | Opaque pixels drawn |
| --- | --- |
| `opacity: 0` | **0** |
| `left: -20000px` (off-screen) | **0** |
| `clip-path: inset(100%)` | **0** |
| on-screen, `opacity: 1` | full |
| `position: fixed; z-index: -2147483000` | full |
| `opacity: 0.005` | full |

So the usual "hide the scratch element" tricks silently produce an empty capture. We park the host
canvas at `opacity: 0.005` behind everything — visually undetectable, still painted.

## 2. What canvasui.dev does

<https://canvasui.dev> (source: <https://github.com/DavidHDev/canvas-ui>) says only that
"components that draw live HTML on canvas rely on an experimental browser capability, available
today in Chrome behind a flag" — it names neither the method nor the flag. Its Particle Reveal
component takes the spec-blessed arrangement: the component *owns* its content, so it can render
that content as a `<canvas layoutsubtree>` child in JSX and draw it directly. That works when the
canvas is the thing rendering your markup.

It does not generalise to "destroy the page you are already on", which is our problem.

## 3. Design chosen: the mirror canvas

We cannot pass `document.body` to `drawElementImage()` — it is not a canvas child. Two options:

**(a) Move the real content root into the canvas.** Spec-pure and gives a genuinely live surface,
but re-parenting the page's root re-creates every iframe, restarts media, re-resolves `position:
fixed` containing blocks, and re-fires observers. For a library that attaches to somebody else's
page this is unacceptable. **Rejected.**

**(b) Mirror a pruned clone into a host canvas and re-draw it cheaply.** Chosen.

So live mode is honestly **"instant re-capture on demand"**, not zero-copy live DOM. What it buys
over the html-to-image snapshot path is real and large:

| | snapshot (html-to-image) | live (`drawElementImage`) |
| --- | --- | --- |
| Cost per capture (this site, 1440×2449) | ~0.5–2 s | **~6 ms** (5 ms clone + 0.5 ms draw) |
| Mechanism | clone → inline every computed style → serialize to SVG → base64 → decode `Image` | clone → prune → one GPU draw |
| Refreshable while destroyed | no | yes, ~1 Hz |
| Needs a flag | no | yes |

Because a refresh is ~6 ms we re-clone from the *live* DOM every `liveRefreshMs` (default 1000).
The clock in the site hero therefore keeps ticking under the destruction until you destroy that
region — that is the demo, and it is delivered by cheap re-capture rather than by the canvas
holding live DOM.

### Making the clone faithful

Two defects showed up in measurement, both fixed:

1. **CSS animations restart in a clone.** The hero's `fade-in-up` animation was finished
   (`opacity: 1`) on the real element but at `opacity: 0.126` in the freshly-cloned twin, so the
   whole hero was missing from the capture. Fix: walk `contentRoot.getAnimations({subtree: true})`,
   and for each animation copy the *current computed value* of every property it touches onto the
   cloned twin with `!important` (which outranks CSS animations in the cascade), then pin
   `animation-name: none` / `transition: none` on the twin. 48 properties get synced on this site
   and the capture becomes faithful.

2. **A cloned `<body>` still hits CSS background propagation**, so its own background colour is not
   painted and the capture comes out transparent. Fix: reuse the existing `resolvePageBackdrop()`
   from `capture.ts` and fill the backdrop under the drawn element — exactly what the snapshot path
   already does.

We also reset `visibility: visible` on the clone, because in content mode the engine has set
`visibility: hidden` on the real root and `cloneNode` copies that inline style.

### Known caveats (documented, not fixed)

- `position: fixed` descendants resolve against the mirror canvas rather than the real viewport, so
  a fixed nav captures at document y=0 instead of at the top of the screen. The snapshot path fixes
  this with `pinFixedDescendants()` (see `capture.ts`); **the live path deliberately does not**, and
  the next bullet is why.

- **Moving a full-page overlay makes `drawElementImage` drop unrelated content.** Measured on
  Chrome 149, this site scrolled to y=1549: re-anchoring the page's `fixed; inset: 0` grid overlay
  from document y 0–900 to y 1549–2449 (so it stops covering the hero) makes the hero paragraph, the
  status line and every finished `fade-in-up` element vanish from the raster — while the clone's own
  DOM still reports `opacity: 1`, the right rect, and `animation-name: none`. It is the *movement*
  that does it, not the position property and not the explicit sizing: leaving the overlay
  `absolute` at document 0 captures fine, and pinning only the nav or only the corner widget
  captures fine. Ruled out by measurement: `content-visibility: auto` (forced to `visible` across
  the whole clone — no change), compositor promotion (`animation` / `transition` / `will-change`
  neutralised across the whole clone — no change), and an extra rendering frame before the draw.
  Same family as the "canvas must actually be painted" surprise above: what Chrome records for a
  `layoutsubtree` canvas depends on paint-time layer decisions that are not observable or
  controllable from CSS. Losing page content is worse than a nav in the wrong place, so live mode
  leaves fixed elements where the mirror puts them.

- Pseudo-elements are out of the pin's reach in either mode: a `::before { position: fixed }`
  full-page grain or vignette can be neither measured nor styled per-element, so it resolves against
  the whole document. On this site that costs a phase shift in a repeating noise texture —
  statistically loud in a pixel diff (≈+4 average delta when scrolled), perceptually nil.
- Selector context shifts: the clone sits at `html > canvas > body-clone`, so a rule anchored on
  `html > body` stops matching. Inherited properties and custom properties are unaffected —
  verified identical computed `color`, `font-family`, `font-size` and `--background` between a real
  element and its twin.
- Canvas contents, form state, and scroll offsets inside the subtree are not cloned.
- Cross-origin iframes render blank by design (read-back-allowed rendering).

## 4. Layering: base vs wounds

Refreshing the base would erase destruction if the content canvas were a single mutable surface —
which is what snapshot mode has. So `ContentLayer` grows a split, **used only in live mode**:

- `base` — the freshly captured page. Replaced wholesale on refresh. Also the repair source.
- `wounds` — an alpha mask of everything removed (punch / burn / cut), drawn opaque.
- `decals` — char marks, drawn normally.

Composite each refresh: `base` → `decals` with `source-atop` → `wounds` with `destination-out`.

Destruction ops build their randomised geometry into a `Path2D` **once** and replay it against both
the visible canvas (immediate feedback) and the wound mask (persistence), so the two never drift.

**Snapshot mode is untouched** — same single canvas, same pristine snapshot, same direct
`destination-out`, no extra allocations. `wounds`/`decals` are allocated lazily on first damage and
only when live.

## 5. Public API

```ts
new DestroyerEngine({
  captureMode: "auto",   // "auto" (default) | "snapshot" | "live"
  liveRefreshMs: 1000,   // 0 disables periodic refresh
});

engine.captureStatus;    // "idle" | "capturing" | "snapshot" | "live"
engine.liveUnavailable;  // true if live was asked for and the API is missing
engine.refreshContent(); // manual re-capture (live only)
engine.on("statuschange", cb);
```

- `"auto"` — live when `drawElementImage` exists, else snapshot. Backwards compatible: on any
  browser without the flag this is byte-identical to today's behaviour.
- `"live"` — require the API; if it is missing, or the first live capture throws, warn and fall
  back to snapshot. `liveUnavailable` drives the toolbar chip's "(live unavailable)" text.
- `"snapshot"` — never touch the experimental API.

## Sources

- <https://github.com/WICG/html-in-canvas>
- <https://developer.chrome.com/blog/html-in-canvas-origin-trial>
- <https://html-in-canvas.dev/>
- <https://tympanus.net/codrops/2026/05/13/exploring-the-html-in-canvas-proposal/>
- <https://canvasui.dev/>
