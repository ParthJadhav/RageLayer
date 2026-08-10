# Desktop Destroyer

[![npm version](https://img.shields.io/npm/v/desktop-destroyer?color=dc5a1f)](https://www.npmjs.com/package/desktop-destroyer)
[![CI](https://github.com/ParthJadhav/desktop-destroyer/actions/workflows/ci.yml/badge.svg)](https://github.com/ParthJadhav/desktop-destroyer/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-3178c6)](https://parthjadhav.github.io/desktop-destroyer/api)
[![MIT license](https://img.shields.io/badge/license-MIT-171310)](./LICENSE)

Turn any web page into a destructible canvas. Smash, cut, corrode, freeze, explode, glitch, undo,
and combine effects across material-aware page regions—then sweep everything back into place.

[**Try the live demo**](https://parthjadhav.github.io/desktop-destroyer/demo/) ·
[Documentation](https://parthjadhav.github.io/desktop-destroyer/) ·
[Tool gallery](https://parthjadhav.github.io/desktop-destroyer/tools) ·
[API reference](https://parthjadhav.github.io/desktop-destroyer/api)

![A page after a Desktop Destroyer session](./docs/screenshots/aftermath.png)

## Why Desktop Destroyer?

- **It destroys the real page.** The DOM is captured into a canvas, so bullets punch holes
  through content and fire burns text and images away.
- **Pieces become physical objects.** Voronoi shards and measured DOM elements tumble, collide,
  and pile up through a built-in rigid-body solver.
- **Nineteen procedural tools.** The original thirteen plus Gravity Gun, Laser Cutter, Acid
  Sprayer, Wrecking Ball, Sticky Bombs, and Glitch Gun—with no model assets or network requests,
  exact icon silhouettes, and configurable scale.
- **Systems that make tools interact.** Seven spatial combos, seven built-in materials, bounded
  undo/redo history, named loadouts, and a typed stateful custom-tool SDK.
- **A real toolbar on every stack.** A complete React component, a complete Vue component, and a
  `<desktop-destroyer>` custom element for everything else — all three rendering one shared,
  framework-neutral toolbar model that you can also use to build your own.
- **Operable without a mouse.** Keyboard aiming puts a cursor on the page that arrow keys steer
  and Enter fires, so the tools themselves — not just the toolbar — are reachable from the
  keyboard. Every string, including tool names, can be translated.
- **Typed and extensible.** Custom tools are plain TypeScript objects with access to the same
  rendering, physics, fire, frost, and page-damage APIs as the built-ins.
- **Designed to degrade well.** WebGL effects, page capture, audio, and physics fail or disable
  independently; adaptive quality keeps entity counts and rendering cost bounded, honors data
  saver, and suspends work in background tabs.

## Install

```sh
npm install desktop-destroyer
# pnpm add desktop-destroyer
# bun add desktop-destroyer
```

Modern ESM and TypeScript declarations are included. React, React DOM, and Vue are optional peer
dependencies: install only the framework entry you use.

## React / Next.js

The ready-made component mounts the engine, renders an accessible toolbar, handles keyboard
shortcuts, and disposes everything when it unmounts.

```tsx
import { useState } from "react";
import { DesktopDestroyer } from "desktop-destroyer/react";

export function DestroyButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button onClick={() => setOpen(true)}>Destroy this page</button>
      {open && <DesktopDestroyer onClose={() => setOpen(false)} />}
    </>
  );
}
```

The entry is marked `"use client"`, so it can be imported from a Next.js Client Component. Lazy
load it behind the trigger if you want the normal page visit to pay no engine cost.

For a custom UI, use the headless hook:

```tsx
import { useDesktopDestroyer } from "desktop-destroyer/react";

function DestroyButton() {
  const destroyer = useDesktopDestroyer({ initialTool: "flamethrower" });
  return <button onClick={destroyer.toggle}>{destroyer.isOpen ? "Repair" : "Destroy"}</button>;
}
```

## Vue / Nuxt

The Vue component is the same ready-made toolbar as the React one:

```vue
<script setup lang="ts">
import { ref } from "vue";
import { DesktopDestroyer } from "desktop-destroyer/vue";

const open = ref(false);
</script>

<template>
  <button @click="open = true">Destroy this page</button>
  <DesktopDestroyer v-if="open" @close="open = false" />
</template>
```

It renders nothing until it is mounted in a browser, so it is safe in a Nuxt page without
`<ClientOnly>`. For a custom UI, use the headless composable, which closes the engine with its Vue
effect scope:

```vue
<script setup lang="ts">
import { useDesktopDestroyer } from "desktop-destroyer/vue";

const { isOpen, toggle } = useDesktopDestroyer({ initialTool: "hammer" });
</script>

<template>
  <button @click="toggle">{{ isOpen ? "Repair" : "Destroy this page" }}</button>
</template>
```

## Svelte, Angular, Solid, Astro — and plain HTML

The custom element is a complete toolbar that needs no framework wrapper:

```html
<script type="module">
  import "desktop-destroyer/element";
</script>

<desktop-destroyer initial-tool="hammer"></desktop-destroyer>
```

It builds its UI in a shadow root, emits `dd-close` when the visitor closes it, and disposes the
engine when the element leaves the document.

### Svelte's own action

To wire your own launcher instead:

```svelte
<script lang="ts">
  import { desktopDestroyer } from "desktop-destroyer/svelte";
</script>

<button use:desktopDestroyer={{ initialTool: "hammer" }}>Destroy this page</button>
```

It toggles on repeated clicks, maintains `aria-pressed`, and closes automatically when the button
is destroyed.

## Vanilla JS and every other framework

The lazy controller does no browser work until `open()`, which makes it safe to create during SSR:

```ts
import { createDesktopDestroyer } from "desktop-destroyer";

const destroyer = createDesktopDestroyer({ initialTool: "hammer" });

document.querySelector("#destroy")?.addEventListener("click", () => destroyer.toggle());
window.addEventListener("pagehide", () => destroyer.close());
```

If you already own the lifecycle, mount the engine directly:

```ts
import { mountDesktopDestroyer } from "desktop-destroyer";

const engine = mountDesktopDestroyer({ initialTool: "blackhole", soundEnabled: true });
engine.clear();
engine.dispose();
```

| Stack | Supported API | Package entry |
| --- | --- | --- |
| React 18/19, Next.js | Component + headless hook | `desktop-destroyer/react` |
| Vue 3, Nuxt | Component + composable | `desktop-destroyer/vue` |
| Svelte, SvelteKit | Custom element + action | `desktop-destroyer/element`, `/svelte` |
| Astro, Angular, Solid, Qwik | Custom element or controller | `desktop-destroyer/element` |
| Plain JavaScript / TypeScript | Controller or direct engine | `desktop-destroyer` |
| Your own toolbar UI | Headless toolbar model | `desktop-destroyer/toolbar` |

See the [integration guide](./docs/integrations.md) for SSR, cleanup and custom toolbars, and
[`examples/`](./examples) for runnable Next.js, Nuxt, SvelteKit and no-framework starters.

## Custom tools

A tool is a small object. Persistent marks go on `surfaceCtx`; transient effects go on `fxCtx`.

```ts
import type { Tool } from "desktop-destroyer";

export const stamp: Tool = {
  id: "stamp",
  name: "Stamp",
  icon: "🐾",
  hint: "click to stamp",
  onDown(engine, event) {
    engine.surfaceCtx.fillText("🐾", event.x, event.y);
    engine.shake(3);
  },
};
```

Pass custom tools through `tools` on any helper or framework adapter. The full contract is in the
[custom tools guide](./docs/api.md#custom-tools).

For isolated state, rate-limited effects, and exact custom icon bounds, use `defineTool()` from
`desktop-destroyer/sdk`. See the [advanced systems guide](./docs/advanced.md).

## Package entry points

| Import | Exports |
| --- | --- |
| `desktop-destroyer` | Engine, lifecycle helpers, built-in tools, types, and low-level primitives |
| `desktop-destroyer/engine` | Engine and public contracts without built-in tool models |
| `desktop-destroyer/tools` | Seven everyday tools (`baseTools`) |
| `desktop-destroyer/tools/heavy` | Six cinematic and physics-heavy tools |
| `desktop-destroyer/tools/advanced` | Gravity, laser, acid, wrecking ball, sticky bombs, and glitch tools |
| `desktop-destroyer/lazy` | On-demand loaders for base, heavy, or complete toolsets |
| `desktop-destroyer/loadouts` | Immutable named presets and custom loadout helpers |
| `desktop-destroyer/sdk` | Typed custom-tool factories, rate limiter, and icon metadata |
| `desktop-destroyer/react` | `DesktopDestroyer`, `useDesktopDestroyer` |
| `desktop-destroyer/vue` | `useDesktopDestroyer` |
| `desktop-destroyer/svelte` | `desktopDestroyer`, `createDesktopDestroyer` |
| `desktop-destroyer/element` | `<desktop-destroyer>`, the toolbar for every other stack |
| `desktop-destroyer/toolbar` | `ToolbarModel`, `DEFAULT_STRINGS` — build your own toolbar |

The package is ESM-only, tree-shakeable, and has zero runtime dependencies — the `html-to-image`
capture code ships inside the package as its own chunk that is loaded only when snapshot capture
runs, so `dist` also works loaded directly in a browser without a bundler.

For the smallest deliberate setup, combine the engine-only and base-tool entries:

```ts
import { DestroyerEngine } from "desktop-destroyer/engine";
import { baseTools } from "desktop-destroyer/tools";

const engine = new DestroyerEngine({ toolScale: 1.15 });
engine.registerTools(baseTools);
engine.setTool("hammer");
```

Later, `loadHeavyTools()` from `desktop-destroyer/lazy` can unlock the cinematic tools without
putting them in the initial graph. See [procedural 3D models](./docs/models.md).

## Browser support

Desktop Destroyer targets current evergreen browsers and requires Canvas 2D. Chrome is covered by
the runtime smoke suite. WebGL/WebGL2, WebAudio, and experimental live capture are enhancements;
the engine falls back without them. Construct or open an engine only in the browser.

Page capture inherits normal browser security rules. Cross-origin images without CORS permission
may prevent a complete snapshot; the engine then keeps the real page visible and uses overlay-only
damage. See [capture and framework integration notes](./docs/integrations.md).

## Documentation

- [Getting started](./docs/getting-started.md)
- [Framework integrations](./docs/integrations.md)
- [API reference](./docs/api.md)
- [Tool gallery](./docs/tools.md)
- [Toolbars, translation and keyboard use](./docs/toolbar.md)
- [Procedural 3D models and loading](./docs/models.md)
- [Materials, combos, history, loadouts, and SDK](./docs/advanced.md)
- [Architecture](./docs/architecture.md)
- [Performance and benchmarks](./docs/performance.md)
- [Compatibility](./docs/compatibility.md)
- [Accessibility](./docs/accessibility.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Versioning and API stability](./docs/versioning.md)
- [Contributing](./CONTRIBUTING.md)
- [Maintainer guide](./MAINTAINERS.md)
- [Security policy](./SECURITY.md)

## Development

```sh
bun install
bun run check         # types, lint, unit tests + coverage floors, build, package validation
bun run test:browser  # runtime suite in headless Chrome (real WebGL, real capture)
bun run docs:dev      # local documentation site
bun run docs:build    # production docs + live demo
```

`test:browser` needs a Chrome binary; point `DD_CHROME_PATH` at one if it is not on the default
path. It is the only place page capture, the WebGL2 surface shader and the post-processing chain
actually execute, so run it before changing any of them.

Changes are released with Changesets. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a
pull request.

## Credits

Inspired by the classic Windows Desktop Destroyer toy and by
[canvasui.dev](https://canvasui.dev)'s HTML-in-canvas work.

## License

[MIT](./LICENSE) © Parth Jadhav
