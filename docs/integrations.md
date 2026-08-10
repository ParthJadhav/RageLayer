# Framework integrations

Desktop Destroyer keeps the rendering engine framework-neutral and puts thin lifecycle bindings on
top. Every binding ultimately creates the same `DestroyerEngine`, registers the same tools, and
calls `dispose()` when its owner goes away.

| Stack | First-class API | Entry point |
| --- | --- | --- |
| React / Next.js | Complete toolbar component + headless hook | `desktop-destroyer/react` |
| Vue / Nuxt | Composable | `desktop-destroyer/vue` |
| Svelte / SvelteKit | Launcher action + controller | `desktop-destroyer/svelte` |
| Astro, Angular, Solid, Qwik, vanilla | Lifecycle controller | `desktop-destroyer` |

Size-sensitive custom integrations can import `DestroyerEngine` from
`desktop-destroyer/engine`, everyday tools from `desktop-destroyer/tools`, and cinematic tools from
`desktop-destroyer/tools/heavy`. `desktop-destroyer/lazy` exposes on-demand loaders for all three
toolset choices.

## The SSR rule

Importing any entry point and calling `createDesktopDestroyer()` is server-safe. Opening or mounting
the engine requires `document`, so call `open()`/`toggle()` from a browser event or client lifecycle.
`mountDesktopDestroyer()` deliberately throws a clear error when called on the server.

## React

Use the component when you want the bundled toolbar:

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

Important props:

| Prop | Type | Default | Purpose |
| --- | --- | --- | --- |
| `onClose` | `() => void` | — | Close button / second `Esc` callback |
| `tools` | `Tool[]` | `defaultTools` | Replace the toolbar's tools |
| `loadout` | `BuiltInLoadoutId \| ToolLoadout` | `"all"` | Choose a built-in or custom tool preset; `tools` takes precedence |
| `soundDefault` | `boolean` | `false` | Start with sound enabled |
| `toolStyle` | `"3d" \| "emoji"` | `"3d"` | Drawn tool art or classic cursors |
| `engineOptions` | `DestroyerOptions` | `{}` | Capture, rendering, physics, and quality options |
| `debugGlobal` | `boolean` | `false` | Expose the engine for profiling or end-to-end tests |

Set the `history` engine option to `true` to add Undo and Redo controls to the toolbar. The same
history is available through <kbd>Cmd/Ctrl</kbd>+<kbd>Z</kbd> and
<kbd>Cmd/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> while the destroyer is open.

Use the hook when you provide the controls:

```tsx
import { useDesktopDestroyer } from "desktop-destroyer/react";

function DestroyButton() {
  const { isOpen, toggle, engine } = useDesktopDestroyer({ initialTool: "chainsaw" });
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

`desktop-destroyer/react` preserves a `"use client"` boundary in its published output. Put the
launcher in a Client Component:

```tsx
"use client";

import { DesktopDestroyer } from "desktop-destroyer/react";
import { useState } from "react";

export default function DestroyButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Destroy</button>
      {open ? <DesktopDestroyer onClose={() => setOpen(false)} /> : null}
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
import { DesktopDestroyer } from "desktop-destroyer/vue";

const open = ref(false);
</script>

<template>
  <button @click="open = true">Destroy this page</button>
  <DesktopDestroyer v-if="open" @close="open = false" />
</template>
```

It renders nothing until mounted in a browser and disposes its engine on unmount. For a custom UI,
use the headless composable instead:

```vue
<script setup lang="ts">
import { useDesktopDestroyer } from "desktop-destroyer/vue";

const { isOpen, toggle, close, engine } = useDesktopDestroyer({
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
  onMount(() => import("desktop-destroyer/element"));
</script>

<button onclick={() => (open = true)}>Destroy this page</button>
{#if open}
  <desktop-destroyer initial-tool="hammer" on:dd-close={() => (open = false)}></desktop-destroyer>
{/if}
```

To build your own controls, the action is the shortest integration:

```svelte
<script lang="ts">
  import { desktopDestroyer } from "desktop-destroyer/svelte";
</script>

<button use:desktopDestroyer={{ initialTool: "hammer" }}>Destroy this page</button>
```

It toggles on repeated clicks, maintains `aria-pressed`, and closes when Svelte destroys the node.
Set `toggle: false` for an open-only launcher. The node emits `desktopdestroyerchange`; its event
detail contains `{ open, engine }` for custom controls.

For explicit lifecycle control:

```svelte
<script lang="ts">
  import { onDestroy } from "svelte";
  import { createDesktopDestroyer } from "desktop-destroyer/svelte";

  const destroyer = createDesktopDestroyer({ initialTool: "freeze" });
  onDestroy(destroyer.close);
</script>

<button onclick={() => destroyer.toggle()}>Destroy</button>
```

## Vanilla JavaScript

```ts
import { createDesktopDestroyer } from "desktop-destroyer";

const destroyer = createDesktopDestroyer({ initialTool: "flamethrower" });
const button = document.querySelector<HTMLButtonElement>("#destroy");

button?.addEventListener("click", () => destroyer.toggle());
const unsubscribe = destroyer.subscribe((engine) => {
  if (button) button.ariaPressed = String(engine !== null);
});

// In an SPA teardown:
unsubscribe();
destroyer.close();
```

Use `mountDesktopDestroyer()` when you want an engine immediately, or construct
`DestroyerEngine` directly for full registration control.

### Progressive tool loading

```ts
import { DestroyerEngine } from "desktop-destroyer/engine";
import { baseTools } from "desktop-destroyer/tools";
import { loadHeavyTools } from "desktop-destroyer/lazy";

const engine = new DestroyerEngine({ toolScale: 1.1 });
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
  import { createDesktopDestroyer } from "desktop-destroyer";

  const destroyer = createDesktopDestroyer({ initialTool: "rocket" });
  document.querySelector("#destroy")?.addEventListener("click", () => destroyer.toggle());
</script>
```

## Angular

Keep the controller in a service and close it from the service or owning component:

```ts
import { Injectable, OnDestroy } from "@angular/core";
import { createDesktopDestroyer } from "desktop-destroyer";

@Injectable({ providedIn: "root" })
export class DesktopDestroyerService implements OnDestroy {
  private readonly controller = createDesktopDestroyer({ initialTool: "hammer" });
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
import { createDesktopDestroyer } from "desktop-destroyer";

export function DestroyButton() {
  const destroyer = createDesktopDestroyer({ initialTool: "blackhole" });
  onCleanup(destroyer.close);
  return <button onClick={() => destroyer.toggle()}>Destroy</button>;
}
```

## Any other framework: the custom element

Angular, Solid, Qwik, Astro and plain HTML can all use the same ready-made toolbar, because it is
an element rather than a component:

```ts
import "desktop-destroyer/element";

const destroyer = document.createElement("desktop-destroyer");
destroyer.addEventListener("dd-close", () => destroyer.remove());
document.body.append(destroyer);
```

See [Toolbars, i18n & keyboard](./toolbar.md) for configuration, translation and keyboard use.

## Excluding host UI from capture

Anything carrying `data-dd-ignore` is omitted from the destructible snapshot. Use it for a launcher,
cookie banner, or live widget:

```html
<button data-dd-ignore>Keep this button intact</button>
```

For more control, compose a filter with the default. The callback receives every cloned `Node`, not
only elements:

```ts
import { createDesktopDestroyer, defaultCaptureFilter } from "desktop-destroyer";

createDesktopDestroyer({
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
