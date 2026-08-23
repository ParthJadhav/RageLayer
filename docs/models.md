# Procedural 3D tool models

RageLayer's tools are shaded Canvas vector models rather than downloaded glTF, OBJ, or
bitmap assets. They stay sharp at every device pixel ratio, inherit the engine's animation clock,
and add no network requests. Models use layered gradients, highlights, contours, cast shadows,
and moving mechanical parts to create depth while keeping each pointer hotspot exact.

## Model size

Scale every model without changing its impact point:

```ts
const engine = mountRageLayer({
  toolScale: 1.2, // accepted range: 0.5–2; default: 1
});
```

Only the drawn art scales; the pointer hotspot is unmoved, so a larger model is no less precise.
The engine canvas already renders at its quality-budgeted device pixel ratio.

## Accurate toolbar icons

Every built-in model carries a measured rest-pose silhouette. Icon baking uses those exact bounds,
including narrow claws, bristles, tubes, and antennae, instead of guessing a common box. This also
avoids a synchronous `getImageData()` readback for each of the 16 built-ins. Custom art keeps the
alpha-scan fallback, so it receives an accurate crop without additional metadata.

The gun uses a full pistol silhouette with an open trigger guard, working slide, and cadence-matched
recoil. The water tool is a compact pistol-grip pressure nozzle whose connection stops at the grip,
keeping the held model clear of nearby content.

`toolIconDataUrl(art, size)` produces DPR-aware PNG data URLs and caches identical built-in requests.
Sizes are normalized to 8–256 CSS pixels to avoid accidental oversized allocations.

## Pay only for the tools you use

The default entry remains convenient, but size-sensitive applications can split the system:

```ts
import { RageLayerEngine } from "ragelayer/engine";
import { baseTools } from "ragelayer/tools";

const engine = new RageLayerEngine();
engine.registerTools(baseTools);
engine.setTool("hammer");
```

Load the five heavy tools—Demolition, Rocket Launcher, Lightning, Black Hole, and Bugs—only when a
visitor asks for them:

```ts
import { loadHeavyTools } from "ragelayer/lazy";

engine.registerTools(await loadHeavyTools());
engine.setTool("blackhole");
```

The four advanced models—Gravity Gun, Laser Cutter, Acid Sprayer, and Sticky Bombs—live in their own
graph:

```ts
import { loadAdvancedTools } from "ragelayer/lazy";

engine.registerTools(await loadAdvancedTools());
engine.setTool("gravity-gun");
```

The `engine` graph is budgeted independently from `tools`, `tools/heavy`, and `lazy` in CI. See
[performance](./performance.md#distribution-budgets) for current measured sizes.

## Custom model guidelines

A custom `Tool.art` function draws around `(0, 0)`, which is always the physical hotspot. Keep the
destructive contact at that origin, extend the held object down/right, and derive animation only from
`ToolArtState`. Stateless drawing makes the model deterministic, icon-bakeable, and safe across
multiple engine instances.

Use `ctx.save()`/`ctx.restore()` around every transform and prefer paths/gradients over embedded
images. The engine applies `toolScale` outside the callback, so custom models scale exactly like the
built-ins. If an art function has a known rest-pose silhouette, call
`registerToolIconBounds(art, [x0, y0, x1, y1])` from `ragelayer/sdk` to skip icon readback.
