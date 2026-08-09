# Integrations

The core engine is framework-agnostic — it mounts its own overlay into `document.body` (or a
`target` you choose) and cleans up completely on `dispose()`. Any framework that can run a
click handler can integrate it. The only rule: **create the engine in the browser, never during
server rendering.**

- [React](#react)
- [Next.js](#nextjs)
- [Vanilla / any framework](#vanilla--any-framework)
- [Vue](#vue)
- [Svelte](#svelte)
- [Astro](#astro)
- [Excluding elements from capture](#excluding-elements-from-capture)
- [Bundle impact](#bundle-impact)

## React

```tsx
import { useState } from "react";
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

Props:

| Prop | Type | Default | |
|---|---|---|---|
| `onClose` | `() => void` | — | Called when the user closes the toy |
| `tools` | `Tool[]` | `defaultTools` | Replace or extend the toolset |
| `soundDefault` | `boolean` | `false` | Start with sound on |
| `toolStyle` | `"3d" \| "emoji"` | `"3d"` | Drawn pseudo-3D tool art vs. classic emoji cursors |
| `engineOptions` | `DestroyerOptions` | `{}` | Everything in the [API reference](./api.md#destroyeroptions) |

The component portals its toolbar to `document.body`, registers keyboard shortcuts, and fully
disposes the engine on unmount.

## Next.js

Load the component lazily so it never renders on the server and costs nothing until someone
clicks:

```tsx
"use client";

import { lazy, Suspense, useState } from "react";

const DesktopDestroyer = lazy(() =>
  import("desktop-destroyer/react").then((m) => ({ default: m.DesktopDestroyer })),
);

export function DestroyButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>DESTROY</button>
      {open && (
        <Suspense fallback={null}>
          <DesktopDestroyer onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
```

`next/dynamic` with `ssr: false` works equally well. This is exactly how the component runs in
production on [parthjadhav.com](https://parthjadhav.com) — behind a footer link, zero cost on
normal visits.

## Vanilla / any framework

```ts
import { DestroyerEngine, defaultTools } from "desktop-destroyer";

const engine = new DestroyerEngine({ soundEnabled: true });
for (const tool of defaultTools) engine.registerTool(tool);
engine.setTool("hammer");

// Tool switching drives any UI you like:
engine.setTool("flamethrower");
engine.setTool(null);  // overlay becomes click-through

engine.clear();    // repair everything
engine.dispose();  // remove the overlay and restore the page
```

[`demo/index.html`](../demo/index.html) is a complete, dependency-free integration with its own
toolbar (icons baked from the tools' own art via `toolIconDataUrl`). Serve the repo root with
any static server after `bun run build` and open `/demo/`.

## Vue

```vue
<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { DestroyerEngine } from "desktop-destroyer";

const engine = ref<DestroyerEngine | null>(null);

async function destroy() {
  const { DestroyerEngine, defaultTools } = await import("desktop-destroyer");
  const instance = new DestroyerEngine({ soundEnabled: true });
  for (const tool of defaultTools) instance.registerTool(tool);
  instance.setTool("hammer");
  engine.value = instance;
}

onBeforeUnmount(() => engine.value?.dispose());
</script>

<template>
  <button @click="destroy">Destroy this page</button>
</template>
```

## Svelte

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
  import type { DestroyerEngine } from "desktop-destroyer";

  let engine: DestroyerEngine | null = null;

  async function destroy() {
    const { DestroyerEngine, defaultTools } = await import("desktop-destroyer");
    engine = new DestroyerEngine({ soundEnabled: true });
    for (const tool of defaultTools) engine.registerTool(tool);
    engine.setTool("hammer");
  }

  onDestroy(() => engine?.dispose());
</script>

<button on:click={destroy}>Destroy this page</button>
```

## Astro

```astro
<button id="destroy">Destroy this page</button>

<script>
  document.getElementById("destroy")?.addEventListener("click", async () => {
    const { DestroyerEngine, defaultTools } = await import("desktop-destroyer");
    const engine = new DestroyerEngine({ soundEnabled: true });
    for (const tool of defaultTools) engine.registerTool(tool);
    engine.setTool("hammer");
  });
</script>
```

The `defaultCaptureFilter` already excludes the Astro dev toolbar (and Next/Vite dev overlays)
from the page capture.

## Excluding elements from capture

Anything carrying `data-dd-ignore` is left out of the destructible snapshot — use it for your
own launcher UI, cookie banners, or live widgets:

```html
<div data-dd-ignore>This element won't be captured or destroyed.</div>
```

For more control, pass a `captureFilter` (compose with the default to keep the dev-overlay
exclusions):

```ts
import { defaultCaptureFilter } from "desktop-destroyer";

new DestroyerEngine({
  // Called for every cloned node (elements *and* text) — check instanceof
  // before touching element-only APIs.
  captureFilter: (node) =>
    defaultCaptureFilter(node) &&
    !(node instanceof Element && node.classList.contains("my-widget")),
});
```

## Bundle impact

- ESM, tree-shakeable, `sideEffects: false`.
- One runtime dependency: `html-to-image`, **dynamically imported** only when a snapshot
  capture actually runs.
- The whole engine is ~94 kB gzipped; load it behind the trigger click (as in the Next.js
  example) and normal visits pay nothing.
- Importing the package is SSR-safe (no top-level browser globals); **constructing**
  `DestroyerEngine` requires a browser.
