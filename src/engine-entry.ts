/** Minimal runtime entry point: the engine and its public contracts, without built-in tools. */

export type { ComboEvent, ComboId, ComboTrackerOptions, InteractionKind } from "./combos";
export { COMBO_DEFINITIONS, ComboTracker } from "./combos";
export { RageLayerEngine } from "./engine";
export type { DestructionHistoryEntry, HistoryOptions, HistoryState } from "./history";
export { DestructionHistory } from "./history";
export type { CustomToolDefinition, RateLimiter, ToolIconBounds } from "./sdk";
export { createRateLimiter, createTool, defineTool, registerToolIconBounds } from "./sdk";
export type * from "./types";
