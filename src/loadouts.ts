import { advancedTools } from "./advanced-tools";
import { defaultTools } from "./default-tools";
import { blackHole, demolition, freezeRay, lightning, rocketLauncher } from "./heavy-tools";
import { baseTools, broom, chainsaw, flamethrower, gun, hammer, waterHose } from "./tools";
import type { Tool } from "./types";

export type BuiltInLoadoutId = "all" | "classic" | "precision" | "elemental" | "chaos";

export interface ToolLoadout {
  readonly id: string;
  readonly label: string;
  readonly tools: readonly Tool[];
}

export function createToolLoadout(id: string, label: string, tools: Iterable<Tool>): ToolLoadout {
  if (!id.trim()) throw new TypeError("Loadout id must not be empty");
  const list = [...tools];
  const ids = new Set<string>();
  for (const tool of list) {
    if (ids.has(tool.id)) throw new TypeError(`Duplicate tool id in loadout: ${tool.id}`);
    ids.add(tool.id);
  }
  return Object.freeze({ id, label, tools: Object.freeze(list) });
}

const [gravityGun, laserCutter, acidSprayer, wreckingBall, stickyBombs, glitchGun] = advancedTools;

export const BUILT_IN_LOADOUTS: Readonly<Record<BuiltInLoadoutId, ToolLoadout>> = Object.freeze({
  all: createToolLoadout("all", "Everything", defaultTools),
  classic: createToolLoadout("classic", "Classic", baseTools),
  precision: createToolLoadout("precision", "Precision", [
    hammer,
    gun,
    chainsaw,
    laserCutter,
    gravityGun,
    broom,
  ]),
  elemental: createToolLoadout("elemental", "Elemental", [
    flamethrower,
    waterHose,
    freezeRay,
    lightning,
    acidSprayer,
    broom,
  ]),
  chaos: createToolLoadout("chaos", "Chaos", [
    demolition,
    rocketLauncher,
    blackHole,
    wreckingBall,
    stickyBombs,
    glitchGun,
    broom,
  ]),
});

export function resolveToolLoadout(loadout: BuiltInLoadoutId | ToolLoadout): Tool[] {
  const resolved = typeof loadout === "string" ? BUILT_IN_LOADOUTS[loadout] : loadout;
  if (!resolved) throw new RangeError(`Unknown Desktop Destroyer loadout: ${loadout}`);
  return [...resolved.tools];
}
