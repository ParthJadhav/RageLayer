# Advanced systems

The advanced layer makes destruction composable: nearby effects form combos, gestures can be
undone, toolbars can switch presets, and third-party tools can use the same typed lifecycle as
built-ins.

## Advanced tools

Import all four without pulling them into an engine-only integration:

```ts
import { advancedTools } from "ragelayer/tools/advanced";
// or: const advancedTools = await loadAdvancedTools()

engine.registerTools(advancedTools);
```

| Tool id | Behavior |
|---|---|
| `gravity-gun` | Pulls nearby rigid debris while held and launches the nearest chunk on release |
| `laser-cutter` | Makes an immediate, constant-width structural cut and drops isolated pieces |
| `acid-sprayer` | Keeps visual and structural hits aligned, then creeps a short distance around each deposit |
| `sticky-bombs` | Keeps up to eight attached charges and detonates each after a short fuse |

Their models are procedural Canvas paths with measured icon silhouettes. No bitmap, glTF, OBJ, or
texture request is added.

## Fixed physical response

The captured page is treated internally as one continuous wood-like surface. Its toughness,
density, flammability, conductivity, corrosion resistance, and rebound are fixed so a given gesture
behaves consistently wherever it lands. Page markup and engine options do not alter that response.

## Tool interactions and combos

The engine retains at most 64 recent interaction signals by default. Pairing compatible signals
inside a time and distance window produces one typed `ComboEvent`; a spatial cooldown prevents a
held tool from retriggering the same combo every frame.

| Combo | Pair | Result |
|---|---|---|
| Steam shock | fire + water | douses fire and throws steam |
| Conductive surge | water + electricity | amplified sparks and released bugs |
| Volatile corrosion | acid + fire | non-incendiary chemical blast |
| Orbital bomb | gravity + explosion | stronger debris impulse |

```ts
const engine = new RageLayerEngine({
  combos: { windowMs: 1800, radius: 96, cooldownMs: 800, maxInteractions: 48 },
});

const off = engine.onCombo((combo) => analytics.track(combo.id));
engine.signalInteraction("acid", 420, 180); // custom tools participate too
```

Pass `combos: false` to remove tracking and combo feedback entirely.

## Destruction history

History is opt-in because a full-page pixel checkpoint is inherently large. Both entry count and
retained pixels are hard-capped; a checkpoint larger than `maxPixels` is rejected and its backing
canvases are released immediately.

```ts
const engine = mountRageLayer({
  history: { maxEntries: 6, maxPixels: 24_000_000 },
});

engine.undo();
engine.redo();
engine.checkpoint("before scripted sequence");
engine.historyState; // canUndo, canRedo, undoDepth, redoDepth
engine.on("historychange", updateButtons);
```

Each pointer gesture automatically records its pre-action persistent state. Undo restores content
pixels, live-mode wounds/decals, overlay damage, the fire-fuel grid, destruction level, and demolished
element flags. Transient fire, particles, bugs, singularities, and loose bodies are cleared so a
restored surface never fights stale simulation state. `clearHistory()` and `dispose()` release every
retained canvas.

## Choosing the toolset

Every lifecycle and framework API registers all sixteen built-in tools by default, and every
toolbar shows all sixteen. Pass a `tools` array to narrow that:

```ts
import { hammer, broom } from "ragelayer/tools";

mountRageLayer(); // all sixteen
mountRageLayer({ tools: [hammer, broom] });
```

There is no preset mechanism: a preset is an array literal, and hiding half the catalog behind a
picker cost more discoverability than the shorter row bought. `mountRageLayer()` and
`createRageLayer()` select `"hammer"` when `initialTool` is omitted — pass `initialTool: null` to
mount click-through. The ready-made toolbar components begin empty-handed so the host page remains
clickable until the visitor chooses a tool.

## Custom tool SDK

`defineTool()` returns a factory, giving every engine an independent state object. `createTool()` is
the single-instance shortcut.

```ts
import { createRateLimiter, defineTool } from "ragelayer/sdk";

export const makeConfettiDrill = defineTool({
  id: "confetti-drill",
  name: "Confetti Drill",
  icon: "🎉",
  hint: "hold to drill",
  createState: () => ({ rate: createRateLimiter(30, 5) }),
  // This tool has no fuse/projectile work after release, so selection alone
  // never needs to keep the frame loop alive.
  hasPendingWork: () => false,
  tick(state, engine, dt, held, pointer) {
    if (!held || !engine.onPage(pointer.x, pointer.y)) return;
    for (let i = 0; i < state.rate.take(dt); i++) {
      engine.content?.burn(pointer.x, pointer.y, 4);
      engine.signalInteraction("impact", pointer.x, pointer.y);
    }
  },
  reset(state) {
    state.rate.reset();
  },
});

const engine = new RageLayerEngine();
engine.registerTool(makeConfettiDrill());
```

The SDK preserves inferred state types across `onDown`, `onMove`, `onUp`, `tick`,
`hasPendingWork`, `backgroundTick`, and `reset`. Pair the two background hooks for a fuse or
projectile that must continue after another tool is selected; return `false` for held-only tools so
their selected idle state can sleep. `createRateLimiter()` prevents a stalled frame from releasing
an unbounded effect burst. Custom procedural models can register measured icon bounds with
`registerToolIconBounds()`.
