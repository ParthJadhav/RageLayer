# Framework integrations

RageLayer keeps the rendering engine framework-neutral and puts thin lifecycle bindings on
top. Every binding ultimately creates the same `RageLayerEngine`, registers the same tools, and
calls `dispose()` when its owner goes away.

| Stack | First-class API | Entry point |
| --- | --- | --- |
| React / Next.js | Complete toolbar component + headless hook | `ragelayer/react` |
| Vue / Nuxt | Composable | `ragelayer/vue` |
| Svelte / SvelteKit | Launcher action + controller | `ragelayer/svelte` |
| Astro, Angular, Solid, Qwik, vanilla | Lifecycle controller | `ragelayer` |

Size-sensitive custom integrations can import `RageLayerEngine` from
`ragelayer/engine`, everyday tools from `ragelayer/tools`, and cinematic tools from
`ragelayer/tools/heavy`. `ragelayer/lazy` exposes on-demand loaders for all three
toolset choices.

## The SSR rule

Importing any entry point and calling `createRageLayer()` is server-safe. Opening or mounting
the engine requires `document`, so call `open()`/`toggle()` from a browser event or client lifecycle.
`mountRageLayer()` deliberately throws a clear error when called on the server.

## React

Use the component when you want the bundled toolbar:

```tsx
import { useState } from "react";
import { RageLayer } from "ragelayer/react";

export function DestroyButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Destroy this page</button>
      {open && <RageLayer onClose={() => setOpen(false)} />}
    </>
  );
}
```

Important props:

| Prop | Type | Default | Purpose |
| --- | --- | --- | --- |
| `onClose` | `() => void` | — | Close button / second `Esc` callback |
| `tools` | `Tool[]` | `defaultTools` | Replace the toolbar's tools |
| `soundDefault` | `boolean` | `false` | Start with sound enabled |
| `toolStyle` | `"3d" \| "emoji"` | `"3d"` | Drawn tool art or classic cursors |
| `strings` | `Partial<RageLayerStrings>` | English defaults | Translate or reword toolbar labels and tool hints |
| `engineOptions` | `RageLayerEngineOptions` | `{}` | Capture, rendering, physics, and quality options |
| `debugGlobal` | `boolean` | `false` | Expose the engine for profiling or end-to-end tests |

Set the `history` engine option to `true` to add Undo and Redo controls to the toolbar. The same
history is available through <kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd> and
<kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> while RageLayer is open.

Use the hook when you provide the controls:

```tsx
import { useRageLayer } from "ragelayer/react";

function DestroyButton() {
  const { isOpen, toggle, engine } = useRageLayer({ initialTool: "chainsaw" });
  return (
    <>
      <button onClick={toggle}>{isOpen ? "Close" : "Destroy"}</button>
      {isOpen && <button onClick={() => engine?.clear()}>Repair</button>}
    </>
  );
}
```

The component and hook both dispose the engine on unmount.

## Next.js

`ragelayer/react` preserves a `"use client"` boundary in its published output. Put the
launcher in a Client Component:

```tsx
"use client";

import { RageLayer } from "ragelayer/react";
import { useState } from "react";

export default function DestroyButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Destroy</button>
      {open ? <RageLayer onClose={() => setOpen(false)} /> : null}
    </>
  );
}
```

For zero engine cost before the click, lazy-load the component with `React.lazy` or
`next/dynamic`. The component itself renders nothing during server rendering.

## Vue 3

The ready-made toolbar is a component:

```vue
<script setup lang="ts">
import { ref } from "vue";
import { RageLayer } from "ragelayer/vue";

const open = ref(false);
</script>

<template>
  <button @click="open = true">Destroy this page</button>
  <RageLayer v-if="open" @close="open = false" />
</template>
```

It renders nothing until mounted in a browser and disposes its engine on unmount. For a custom UI,
use the headless composable instead:

```vue
<script setup lang="ts">
import { useRageLayer } from "ragelayer/vue";

const { isOpen, toggle, close, engine } = useRageLayer({
  initialTool: "hammer",
});
</script>

<template>
  <button @click="toggle">{{ isOpen ? "Close" : "Destroy this page" }}</button>
  <button v-if="isOpen" @click="engine?.clear()">Repair</button>
</template>
```

The composable returns shallow/computed refs and closes the engine with its Vue effect scope.

### Nuxt

The same composable works in a normal `.vue` component because `open()` is called by a client-side
click. If a component opens automatically, wrap it in `<ClientOnly>` and call `open()` from
`onMounted`.

## Svelte / SvelteKit

For a ready-made toolbar, use the custom element — it needs no Svelte-specific wrapper:

```svelte
<script lang="ts">
  import { onMount } from "svelte";

  let open = $state(false);
  onMount(() => import("ragelayer/element"));
</script>

<button onclick={() => (open = true)}>Destroy this page</button>
{#if open}
  <rage-layer initial-tool="hammer" on:ragelayer-close={() => (open = false)}></rage-layer>
{/if}
```

To build your own controls, the action is the shortest integration:

```svelte
<script lang="ts">
  import { rageLayer } from "ragelayer/svelte";
</script>

<button use:rageLayer={{ initialTool: "hammer" }}>Destroy this page</button>
```

It toggles on repeated clicks, maintains `aria-pressed`, and closes when Svelte destroys the node.
Set `toggle: false` for an open-only launcher. The node emits `ragelayerchange`; its event
detail contains `{ open, engine }` for custom controls.

For explicit lifecycle control:

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
  import { createRageLayer } from "ragelayer/svelte";

  const rageLayer = createRageLayer({ initialTool: "laser-cutter" });
  onDestroy(rageLayer.close);
</script>

<button onclick={() => rageLayer.toggle()}>Destroy</button>
```

## Vanilla JavaScript

```ts
import { createRageLayer } from "ragelayer";

const rageLayer = createRageLayer({ initialTool: "flamethrower" });
const button = document.querySelector<HTMLButtonElement>("#destroy");

button?.addEventListener("click", () => rageLayer.toggle());
const unsubscribe = rageLayer.subscribe((engine) => {
  if (button) button.ariaPressed = String(engine !== null);
});

// In an SPA teardown:
unsubscribe();
rageLayer.close();
```

Use `mountRageLayer()` when you want an engine immediately, or construct
`RageLayerEngine` directly for full registration control.

### Progressive tool loading

```ts
import { RageLayerEngine } from "ragelayer/engine";
import { baseTools } from "ragelayer/tools";
import { loadHeavyTools } from "ragelayer/lazy";

const engine = new RageLayerEngine({ toolScale: 1.1 });
engine.registerTools(baseTools);

async function unlockCinematicTools() {
  engine.registerTools(await loadHeavyTools());
}
```

The engine observes layout-size changes when the platform provides `ResizeObserver`, pauses in
background tabs, and safely releases interrupted touch or pen gestures. An SPA still owns final
cleanup and must call `dispose()` or close its lifecycle controller.

## Astro

Astro's regular browser script can use the core controller:

```astro
<button id="destroy">Destroy this page</button>

<script>
  import { createRageLayer } from "ragelayer";

  const rageLayer = createRageLayer({ initialTool: "rocket" });
  document.querySelector("#destroy")?.addEventListener("click", () => rageLayer.toggle());
</script>
```

## Angular

Keep the controller in a service and close it from the service or owning component:

```ts
import { Injectable, OnDestroy } from "@angular/core";
import { createRageLayer } from "ragelayer";

@Injectable({ providedIn: "root" })
export class RageLayerService implements OnDestroy {
  private readonly controller = createRageLayer({ initialTool: "hammer" });
  readonly open = () => this.controller.open();
  readonly close = () => this.controller.close();
  readonly toggle = () => this.controller.toggle();

  ngOnDestroy() {
    this.controller.close();
  }
}
```

## Solid

```tsx
import { onCleanup } from "solid-js";
import { createRageLayer } from "ragelayer";

export function DestroyButton() {
  const rageLayer = createRageLayer({ initialTool: "blackhole" });
  onCleanup(rageLayer.close);
  return <button onClick={() => rageLayer.toggle()}>Destroy</button>;
}
```

## Any other framework: the custom element

Angular, Solid, Qwik, Astro and plain HTML can all use the same ready-made toolbar, because it is
an element rather than a component:

```ts
import "ragelayer/element";

const rageLayer = document.createElement("rage-layer");
rageLayer.addEventListener("ragelayer-close", () => rageLayer.remove());
document.body.append(rageLayer);
```

See [Toolbars, i18n & keyboard](./toolbar.md) for configuration, translation and keyboard use.

## Excluding host UI from capture

Anything carrying `data-ragelayer-ignore` is omitted from the destructible snapshot. Use it for a launcher,
cookie banner, or live widget:

```html
<button data-ragelayer-ignore>Keep this button intact</button>
```

For more control, compose a filter with the default. The callback receives every cloned `Node`, not
only elements:

```ts
import { createRageLayer, defaultCaptureFilter } from "ragelayer";

createRageLayer({
  captureFilter: (node) =>
    defaultCaptureFilter(node) &&
    !(node instanceof Element && node.classList.contains("never-capture")),
});
```

## Bundle behavior

- ESM, tree-shakeable, with explicit framework subpath exports.
- React, React DOM, and Vue are optional peers and never bundled.
- The bundled `html-to-image` chunk is dynamically imported only when snapshot capture runs.
- The controller is lazy: import and creation are SSR-safe; `open()` is the browser boundary.
- Lazy-load the package behind the launcher when initial page weight matters.
