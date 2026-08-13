# Troubleshooting

## The package cannot be imported with `require()`

RageLayer is ESM-only. Use an ESM module or dynamic import:

```js
const { createRageLayer } = await import("ragelayer");
```

## `document is not defined` during SSR

Create a lazy controller on the server, but call `open()` only from a browser event or mounted client
lifecycle. In Next.js, put the launcher in a Client Component. In Nuxt, open automatically only from
`onMounted` or use `<ClientOnly>`.

## The page stays visible instead of becoming destructible

Inspect `engine.captureStatus` and the browser console. Snapshot capture commonly fails because a
cross-origin image, font, stylesheet, or iframe does not grant CORS access. The fallback is deliberate:
the real page remains visible and tools draw on the overlay instead of leaving the site unusable.

Try these checks:

1. Reproduce on a page containing only same-origin content.
2. Add correct `Access-Control-Allow-Origin` headers to remote assets.
3. Remove or filter an unsupported embedded widget.
4. Confirm the capture root has non-zero dimensions.

## A launcher, cookie banner, or widget appears in the snapshot

Add `data-ragelayer-ignore` to the element, or compose a custom `captureFilter` with
`defaultCaptureFilter`. The callback receives every `Node`, including text nodes.

## The overlay is behind a modal or app shell

Raise `zIndex` in the engine options. If the host creates an unusual stacking context, keep the
default body target or choose a target outside that context. The React toolbar portals to
`document.body` specifically to avoid common stacking traps.

## The page is slow or consumes too much memory

- Keep `quality: "auto"` so the engine can step down based on measured frame cost.
- Use `quality: "low"`, disable `postFX`, or disable `surface` on constrained devices.
- Reduce `maxParticles`/`maxFlames` and avoid capturing extremely tall documents.
- Lazy-load the package behind the launcher so normal visits pay no engine cost.
- Always call `dispose()` or use a lifecycle adapter.

Use `engine.performanceSnapshot` or `engine.onPerformance()` to distinguish capture cost from
per-frame rendering. See [performance](./performance.md) for the measurement fields.

## Sound does not play

Sound defaults off. Enable it from a user gesture with `engine.setSound(true)` or
`soundEnabled: true`. Browsers may reject an AudioContext created without user activation.

## React StrictMode opens twice or leaks an overlay

Use the current package version and mount one `RageLayer` component at a time. The wrapper is
StrictMode-safe and cleans up on unmount. If you use the headless hook, call its stable `open`, `close`,
or `toggle` functions rather than constructing an engine during render.

## Multiple overlays interfere with each other

RageLayer is a whole-page experience and the built-in tools retain a small amount of shared
module state. Run one active engine per document. Use one controller at application scope rather than
one controller per button.

## A snapshot or clipboard write fails

Clipboard images require a secure context and browser permission. `copyBlobToClipboard()` returns
`false` when unavailable; fall back to `downloadBlob()`. A tainted source canvas can also block image
export, so check cross-origin assets first.

## Live mode always falls back to snapshot

Live capture depends on an experimental Chromium API and is not required for normal use. Without the
relevant browser flag, `captureMode: "live"` sets `liveUnavailable` and safely falls back to snapshot.
Use `"auto"` unless you are explicitly testing that experiment.

## Getting useful help

Include the package, framework, browser, and operating-system versions; `captureStatus`; console
warnings; and a minimal public reproduction. Never attach a capture containing credentials or private
page data. See the [support guide](https://github.com/ParthJadhav/RageLayer/blob/main/SUPPORT.md).
