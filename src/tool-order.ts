import type { Tool } from "./types";

/**
 * The official toolbar order: the everyday tools, then the heavy ordnance and
 * the advanced tools, with the broom (the last everyday tool) kept at the end
 * as the cleanup that follows everything else.
 */
export function officialToolOrder(
  baseTools: readonly Tool[],
  heavyTools: readonly Tool[],
  advancedTools: readonly Tool[],
): Tool[] {
  return [...baseTools.slice(0, -1), ...heavyTools, ...advancedTools, ...baseTools.slice(-1)];
}
