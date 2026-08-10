# Getting started

`desktop-destroyer` is a self-contained page-destruction toy: it rasterizes the live page into a
destructible canvas, hides the real DOM (layout and scroll survive), and lets visitors smash,
shoot, burn, soak, saw, paint, freeze, bomb — and then sweep it all up. Zero assets, zero
runtime dependencies, framework-agnostic core with a drop-in React component.

![The demo page mid-destruction](./screenshots/aftermath.png)

## Install

Install from npm:

```sh
npm install desktop-destroyer
```

Bun, pnpm and Yarn all work the same way (`bun add desktop-destroyer`, …).

The package ships modern ESM with TypeScript declarations. `react`/`react-dom` are **optional**
peer dependencies — you only need them for the `desktop-destroyer/react` entry.

## 60-second React setup

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

That's the whole integration: a floating toolbar appears, the page becomes destructible, and
`Esc` (or the ✕ button) restores everything and unmounts cleanly.

> **Next.js note:** use it from a Client Component. The published React entry preserves its
> `"use client"` boundary; lazy loading is optional. See [integrations](./integrations.md#nextjs).

## 60-second vanilla setup

```ts
import { createDesktopDestroyer } from "desktop-destroyer";

const destroyer = createDesktopDestroyer({
  initialTool: "flamethrower",
  soundEnabled: true,
});

document.querySelector("#destroy")?.addEventListener("click", () => destroyer.toggle());
```

The controller registers all 19 tools and handles repeated open/close cycles. Build whatever UI
you like on top—the [live demo](./demo/) is a complete example with a hand-rolled toolbar.

## The toolset

| | Tool | Gesture |
|---|---|---|
| 🔨 | Hammer | click — escalating blows until the spot fractures into rigid debris |
| 🔫 | Gun | click / hold for full-auto |
| 🔥 | Flamethrower | hold — fire catches, spreads and eats the page |
| 💦 | Water hose | hold — douses fire, washes stains |
| 🪚 | Chainsaw | drag — close a loop and the piece drops out whole |
| 🎨 | Paintball | click |
| 🏗️ | Demolition | click — knocks a real page element loose as one object |
| 🚀 | Rocket launcher | click |
| ⚡ | Lightning | click |
| ❄️ | Freeze ray | hold — frost resists fire, shatters like glass |
| 🕳️ | Black hole | hold — lenses the page, eats debris, detonates on release |
| 🐛 | Bug | click — releases a bug that gnaws trails through the page |
| 🧹 | Broom | drag — sweeps damage away and repairs content |

Screenshots of each: [tool gallery](./tools.md).

Need a smaller initial graph or different visual sizing? See [procedural 3D models](./models.md) for
`toolScale`, engine-only imports, base/heavy/advanced tool entry points, and on-demand loading.

## Keyboard (React toolbar)

`1`–`9`/`0` select tools · `X` collapse the page · `P` save a PNG · `R` repair · `M` mute ·
`Esc` deselect, then close.

## Where next

- [Integrations](./integrations.md) — React, Next.js, Vue, Svelte, Astro, plain `<script>`
- [API reference](./api.md) — engine options, engine API, custom tools
- [Performance](./performance.md) — adaptive quality, telemetry, benchmarks
- [Procedural 3D models](./models.md) — sizing, fidelity, custom art, and lazy tool loading
- [Architecture](./architecture.md) — how the whole thing works
- [Compatibility](./compatibility.md) — browsers, frameworks, SSR, ESM, and CSP
- [Accessibility](./accessibility.md) — keyboard, reduced motion, and host responsibilities
- [Troubleshooting](./troubleshooting.md) — capture, SSR, layering, sound, and performance fixes
