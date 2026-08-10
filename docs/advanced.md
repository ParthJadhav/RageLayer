# Advanced systems

The advanced layer makes destruction composable: tools react to marked page materials, nearby
effects form combos, gestures can be undone, toolbars can switch presets, and third-party tools can
use the same typed lifecycle as built-ins.

## Advanced tools

Import all six without pulling them into an engine-only integration:

```ts
import { advancedTools } from "desktop-destroyer/tools/advanced";
// or: const advancedTools = await loadAdvancedTools()

engine.registerTools(advancedTools);
```

| Tool id | Behavior |
|---|---|
| `gravity-gun` | Pulls nearby rigid debris while held and launches the nearest chunk on release |
| `laser-cutter` | Heat-marks immediately, then cuts after material-dependent dwell time |
| `acid-sprayer` | Corrodes marked materials according to their resistance and leaves reactive residue |
| `wrecking-ball` | Converts pointer swing velocity into material-aware fractures and impulse |
| `sticky-bombs` | Keeps up to eight attached charges and detonates each after a short fuse |
| `glitch-gun` | Paints bounded RGB corruption, distortion pulses, and occasional structural faults |

Their models are procedural Canvas paths with measured icon silhouettes. No bitmap, glTF, OBJ, or
texture request is added.

## Material regions

Mark any captured element with `data-dd-material`. Nested regions are supported; the deepest match
wins.

```html
<article data-dd-material="paper">
  <img data-dd-material="glass" src="..." alt="..." />
  <button data-dd-material="metal">Launch</button>
</article>
```

Built-ins are `paper`, `glass`, `metal`, `wood`, `stone`, `rubber`, and `ice`. Their toughness,
density, flammability, conductivity, corrosion resistance, restitution, and effect tint influence
fire, lightning, acid, laser dwell, fractures, and debris.

Register a domain-specific material before capture:

```ts
const engine = new DestroyerEngine({
  materials: [{
    id: "carbon-fiber",
    label: "Carbon fiber",
    toughness: 2.8,
    density: 1.4,
    flammability: 0.18,
    conductivity: 0.25,
    corrosionResistance: 0.92,
    restitution: 0.08,
    color: "#24272b",
  }],
});

engine.materialAt(x, y);
engine.materials.get("carbon-fiber");
```

Unknown attributes fall back to paper so existing pages behave exactly as before.

## Tool interactions and combos

The engine retains at most 64 recent interaction signals by default. Pairing compatible signals
inside a time and distance window produces one typed `ComboEvent`; a spatial cooldown prevents a
held tool from retriggering the same combo every frame.

| Combo | Pair | Result |
|---|---|---|
| Steam shock | fire + water | douses fire and throws steam |
| Flash freeze | water + freeze | freezes the wet region and throws ice |
| Conductive surge | water + electricity | amplified sparks and released bugs |
| Thermal shock | freeze + laser | fractures brittle frozen material |
| Volatile corrosion | acid + fire | non-incendiary chemical blast |
| Orbital bomb | gravity + explosion | stronger debris impulse |
| Reality overload | glitch + electricity | corruption burst, char, and camera kick |

```ts
const engine = new DestroyerEngine({
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
const engine = mountDesktopDestroyer({
  history: { maxEntries: 6, maxPixels: 24_000_000 },
});

engine.undo();
engine.redo();
engine.checkpoint("before scripted sequence");
engine.historyState; // canUndo, canRedo, undoDepth, redoDepth
engine.on("historychange", updateButtons);
```

Each pointer gesture automatically records its pre-action persistent state. Undo restores content
pixels, live-mode wounds/decals, overlay damage, frost/fuel grids, destruction level, and demolished
element flags. Transient fire, particles, bugs, singularities, and loose bodies are cleared so a
restored surface never fights stale simulation state. `clearHistory()` and `dispose()` release every
retained canvas.

## Tool loadouts

Every lifecycle and framework API accepts a `loadout` in place of a `tools` array:

```ts
import { createToolLoadout } from "desktop-destroyer/loadouts";
import { hammer, broom } from "desktop-destroyer/tools";

mountDesktopDestroyer({ loadout: "precision" });

const gentle = createToolLoadout("gentle", "Gentle", [hammer, broom]);
mountDesktopDestroyer({ loadout: gentle });
```

Built-ins are `all`, `classic`, `precision`, `elemental`, and `chaos`. Presets and their tool arrays
are frozen; `resolveToolLoadout()` returns a new mutable array. An explicit `tools` array takes
precedence over `loadout`. If no `initialTool` is supplied for a loadout, its first tool is selected.

## Custom tool SDK

`defineTool()` returns a factory, giving every engine an independent state object. `createTool()` is
the single-instance shortcut.

```ts
import { createRateLimiter, defineTool } from "desktop-destroyer/sdk";

export const makeConfettiDrill = defineTool({
  id: "confetti-drill",
  name: "Confetti Drill",
  icon: "🎉",
  hint: "hold to drill",
  createState: () => ({ rate: createRateLimiter(30, 5) }),
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

const engine = new DestroyerEngine();
engine.registerTool(makeConfettiDrill());
```

The SDK preserves inferred state types across `onDown`, `onMove`, `onUp`, `tick`, and `reset`.
`createRateLimiter()` prevents a stalled frame from releasing an unbounded effect burst. Custom
procedural models can register measured icon bounds with `registerToolIconBounds()`.
