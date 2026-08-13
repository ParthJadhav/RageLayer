import type { Tool } from "./types";

/** Load the seven everyday tools without downloading the heavy ordnance module. */
export async function loadBaseTools(): Promise<Tool[]> {
  const { baseTools } = await import("./tools");
  return [...baseTools];
}

/** Load demolition, rockets, lightning, black hole, and bugs on demand. */
export async function loadHeavyTools(): Promise<Tool[]> {
  const { heavyTools } = await import("./heavy-tools");
  return [...heavyTools];
}

/** Load gravity, precision cutting, corrosion, and sticky explosives on demand. */
export async function loadAdvancedTools(): Promise<Tool[]> {
  const { advancedTools } = await import("./advanced-tools");
  return [...advancedTools];
}

/** Load the complete built-in toolbar while preserving its official order. */
export async function loadDefaultTools(): Promise<Tool[]> {
  const [{ baseTools }, { heavyTools }, { advancedTools }] = await Promise.all([
    import("./tools"),
    import("./heavy-tools"),
    import("./advanced-tools"),
  ]);
  return [...baseTools.slice(0, -1), ...heavyTools, ...advancedTools, baseTools.at(-1)!];
}
