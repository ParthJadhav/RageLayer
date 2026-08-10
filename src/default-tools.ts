import { advancedTools } from "./advanced-tools";
import { heavyTools } from "./heavy-tools";
import { baseTools } from "./tools";
import type { Tool } from "./types";

/** Complete built-in toolset in the order used by the official toolbar. */
export const defaultTools: Tool[] = [
  ...baseTools.slice(0, -1),
  ...heavyTools,
  ...advancedTools,
  baseTools.at(-1)!,
];
