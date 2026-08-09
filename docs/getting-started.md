# Getting started

`desktop-destroyer` is a self-contained page-destruction toy: it rasterizes the live page into a
destructible canvas, hides the real DOM (layout and scroll survive), and lets visitors smash,
shoot, burn, soak, saw, paint, freeze, bomb — and then sweep it all up. Zero assets, one
dependency (`html-to-image`), framework-agnostic core with a drop-in React component.

![The demo page mid-destruction](./screenshots/aftermath.png)

## Install

From npm (once published), or straight from the GitHub repo:

```sh
# npm registry
npm install desktop-destroyer

# private GitHub repo (requires repo access)
npm install github:ParthJadhav/desktop-destroyer

# or a release tarball attached to a GitHub Release
npm install ./desktop-destroyer-0.2.0.tgz
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

> **Next.js note:** render the component client-side only (behind a click, or with
> `next/dynamic` and `ssr: false`). See [integrations](./integrations.md#nextjs).

## 60-second vanilla setup

```ts
import { DestroyerEngine, defaultTools } from "desktop-destroyer";

const engine = new DestroyerEngine({ soundEnabled: true });
for (const tool of defaultTools) engine.registerTool(tool);
engine.setTool("flamethrower"); // null makes the overlay click-through
// …later
engine.clear();   // repair everything
engine.dispose(); // remove every trace and restore the page
```

`defaultTools` already contains all 13 tools (the heavy ones included). Build whatever UI you
like on top — [`demo/index.html`](../demo/index.html) is a complete example with a hand-rolled
toolbar in ~60 lines.

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

## Keyboard (React toolbar)

`1`–`9`/`0` select tools · `X` collapse the page · `P` save a PNG · `R` repair · `M` mute ·
`Esc` deselect, then close.

## Where next

- [Integrations](./integrations.md) — React, Next.js, Vue, Svelte, Astro, plain `<script>`
- [API reference](./api.md) — engine options, engine API, custom tools
- [Performance](./performance.md) — adaptive quality, telemetry, benchmarks
- [Architecture](./architecture.md) — how the whole thing works
