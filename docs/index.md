---
layout: home

hero:
  name: Desktop Destroyer
  text: Demolish any web page.
  tagline: A framework-neutral canvas toy with real page capture, rigid-body debris, procedural tools, and drop-in React, Vue, and Svelte integrations.
  image:
    src: /screenshots/aftermath.png
    alt: A web page smashed, burned, frozen, and painted by Desktop Destroyer
  actions:
    - theme: brand
      text: Try the live demo
      link: /demo/
    - theme: alt
      text: Get started
      link: /getting-started

features:
  - icon: 🔨
    title: The real page breaks
    details: Capture the DOM, punch holes through content, and knock measured elements loose as physical objects.
  - icon: ⚛️
    title: Framework ready
    details: Use the vanilla controller, React component or hook, Vue composable, or Svelte action.
  - icon: 🧩
    title: Extensible by design
    details: Register custom tools against a typed engine API and reuse the rendering, physics, and sharing primitives.
  - icon: ⚡
    title: Adaptive performance
    details: Quality tiers, bounded entities, dirty-region rendering, telemetry, and graceful WebGL fallbacks.
---

## Install

::: code-group

```sh [npm]
npm install desktop-destroyer
```

```sh [pnpm]
pnpm add desktop-destroyer
```

```sh [Bun]
bun add desktop-destroyer
```

:::

## Pick your integration

| Stack | Import | Best for |
| --- | --- | --- |
| React / Next.js | `desktop-destroyer/react` | Ready-made toolbar or a headless hook |
| Vue / Nuxt | `desktop-destroyer/vue` | Lifecycle-safe composable |
| Svelte / SvelteKit | `desktop-destroyer/svelte` | One-line launcher action |
| Astro, Angular, Solid, plain JS | `desktop-destroyer` | Framework-neutral controller |

```ts
import { createDesktopDestroyer } from "desktop-destroyer";

const destroyer = createDesktopDestroyer({ initialTool: "hammer" });
document.querySelector("#destroy")?.addEventListener("click", () => destroyer.toggle());
```

[Read the integration guide →](./integrations.md)
