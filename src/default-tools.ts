import { advancedTools } from "./advanced-tools";
import { heavyTools } from "./heavy-tools";
import { officialToolOrder } from "./tool-order";
import { baseTools } from "./tools";
import type { Tool } from "./types";

/** Complete built-in toolset in the order used by the official toolbar. */
export const defaultTools: Tool[] = officialToolOrder(baseTools, heavyTools, advancedTools);
