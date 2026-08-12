# Compatibility

RageLayer is a browser library distributed as modern ESM. Importing it is server-safe;
opening an engine requires a real browser document.

## Browser support

| Browser | Status | Capture mode |
| --- | --- | --- |
| Chrome / Edge (current) | Actively tested in CI | Snapshot; experimental live mode when enabled |
| Firefox (current) | Supported, best-effort manual coverage | Snapshot |
| Safari (current) | Supported, best-effort manual coverage | Snapshot |
| Mobile evergreen browsers | Supported with adaptive quality | Snapshot |

Chrome stable runs the automated runtime and memory smoke suite. Firefox and Safari use the same
standards-based Canvas 2D and `foreignObject` snapshot path, but are not yet automated in CI. If a
browser cannot create WebGL/WebGL2 or WebAudio contexts, those enhancements switch off without
disabling destruction.

Required platform features:

- ES2020 modules and dynamic `import()`;
- Canvas 2D, `requestAnimationFrame`, and Pointer Events;
- DOM APIs such as `Range`, `MutationObserver`, and `getBoundingClientRect`.

`ResizeObserver` is used when available to follow SPA reflows and late-loading content; the regular
window-resize path remains the fallback. Primary Pointer Events are captured during held gestures,
and `pointercancel` is treated as a clean release so touch/pen interruptions cannot leave a tool
stuck on. Background documents suspend automatically unless `pauseWhenHidden: false` is requested.

WebGL2 surface shading, WebGL post-processing, WebAudio, clipboard writes, and Chrome's
HTML-in-Canvas experiment are optional.

## Framework and toolchain support

| Integration | Supported versions | Notes |
| --- | --- | --- |
| React / React DOM | 18 and newer | React 18 and 19 declarations are consumer-tested |
| Next.js | Current App Router and Pages Router | Import from a Client Component; the package preserves `"use client"` |
| Vue / Nuxt | Vue 3.3 and newer | Vue is an optional peer dependency |
| Svelte / SvelteKit | Modern versions supporting actions | The adapter has no Svelte runtime dependency |
| Other frameworks | Any browser-capable version | Use the framework-neutral controller |
| TypeScript | Modern bundler or Node16 resolution | Both modes compile in CI |
| Node.js tooling | 20 and newer | The runtime itself is browser-only |

The package is ESM-only. CommonJS applications must use dynamic `import("ragelayer")` or
move the browser integration into an ESM module.

## SSR behavior

These operations are safe on a server:

```ts
import { createRageLayer } from "ragelayer";

const destroyer = createRageLayer(); // lazy; does not read document
```

`destroyer.open()`, `mountRageLayer()`, and `new DestroyerEngine()` are browser operations.
The direct mount helper throws an actionable error when used during SSR.

## Content Security Policy

Strict sites may need to permit the resources the selected integration creates:

- the React toolbar injects a small `<style>` element and uses inline style properties;
- drawn toolbar icons use `data:` image URLs;
- snapshot capture may fetch same-origin/CORS-enabled fonts and images and encode them as data URLs;
- the package does not use `eval`, load remote scripts, or send page data to a service.

At minimum, test the package with the production policy. Depending on the integration, that can mean
allowing the application's nonce/style policy and `img-src data:`. Prefer a narrowly scoped nonce or
hash policy over broadly weakening CSP. The headless controller avoids the React toolbar's injected
stylesheet when the host supplies its own controls.

## Cross-origin content

Page capture follows normal browser security rules. Images, fonts, iframes, and stylesheets from a
different origin need appropriate CORS headers. If snapshot capture fails, the engine logs a warning,
keeps the real DOM visible, and falls back to overlay-only damage.

## Support policy

Compatibility fixes target the latest package release and current stable browsers/frameworks. When
reporting a browser issue, include a minimal reproduction, exact versions, capture status, and any
console warning. See [troubleshooting](./troubleshooting.md) before filing an issue.
