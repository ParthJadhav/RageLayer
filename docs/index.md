---
layout: home

hero:
  name: RageLayer
  text: Demolish any web page.
  tagline: A framework-neutral canvas toy with real page capture, rigid-body debris, procedural tools, and drop-in React, Vue, and Svelte integrations.
  image:
    src: /screenshots/aftermath.png
    alt: A web page smashed, burned, frozen, and painted by RageLayer
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
npm install ragelayer
```

```sh [pnpm]
pnpm add ragelayer
```

```sh [Bun]
bun add ragelayer
```

:::

## Pick your integration

| Stack | Import | Best for |
| --- | --- | --- |
| React / Next.js | `ragelayer/react` | Ready-made toolbar or a headless hook |
| Vue / Nuxt | `ragelayer/vue` | Lifecycle-safe composable |
| Svelte / SvelteKit | `ragelayer/svelte` | One-line launcher action |
| Astro, Angular, Solid, plain JS | `ragelayer` | Framework-neutral controller |

```ts
import { createRageLayer } from "ragelayer";

const destroyer = createRageLayer({ initialTool: "hammer" });
document.querySelector("#destroy")?.addEventListener("click", () => destroyer.toggle());
```

[Read the integration guide →](./integrations.md)
