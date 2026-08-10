/**
 * Every user-visible string the built-in UI produces.
 *
 * The package ships one language. Rather than pull in a translation runtime,
 * the strings are a plain object a host can override wholly or in part —
 * which is also what lets a host reword the toy for its own tone of voice, not
 * just translate it. Tool names and hints come from the tools themselves, so
 * they are overridden by id.
 */

export interface DestroyerToolStrings {
  name?: string;
  hint?: string;
}

export interface DestroyerStrings {
  /** Accessible name of the toolbar itself. */
  toolbarLabel: string;
  undo: string;
  redo: string;
  undoHint: string;
  redoHint: string;
  collapse: string;
  snapshot: string;
  muteSound: string;
  enableSound: string;
  repair: string;
  close: string;
  closeTitle: string;
  /** Transient confirmations after an action. */
  copiedToClipboard: string;
  saved: string;
  /** Capture-status chip. */
  capturing: string;
  capturingTitle: string;
  live: string;
  liveTitle: string;
  snapshotMode: string;
  snapshotModeTitle: string;
  snapshotLiveUnavailable: string;
  snapshotLiveUnavailableTitle: string;
  /** Keyboard-driven destruction, announced to assistive technology. */
  keyboardCursor: string;
  keyboardCursorHint: string;
  keyboardMoved: string;
  keyboardStruck: string;
  /** Per-tool overrides, keyed by tool id. */
  tools?: Record<string, DestroyerToolStrings>;
}

export const DEFAULT_STRINGS: DestroyerStrings = {
  toolbarLabel: "Desktop Destroyer tools",
  undo: "Undo destruction",
  redo: "Redo destruction",
  undoHint: "Cmd/Ctrl+Z",
  redoHint: "Cmd/Ctrl+Shift+Z",
  collapse: "Collapse the whole page",
  snapshot: "Save a picture of the wreckage",
  muteSound: "Mute sound",
  enableSound: "Enable sound",
  repair: "Repair everything",
  close: "Close Desktop Destroyer",
  closeTitle: "Close (Esc)",
  copiedToClipboard: "Copied to clipboard",
  saved: "Saved",
  capturing: "Capturing page…",
  capturingTitle: "Rasterizing the page into the destructible canvas.",
  live: "Live",
  liveTitle:
    "Live capture — experimental Chrome HTML-in-canvas (drawElementImage): the page stays live under the destruction and re-captures itself about once a second.",
  snapshotMode: "Snapshot",
  snapshotModeTitle: "Snapshot capture — the page is frozen at activation. Close to unfreeze.",
  snapshotLiveUnavailable: "Snapshot (live unavailable)",
  snapshotLiveUnavailableTitle:
    "Live capture was requested but this browser doesn't expose it. Enable chrome://flags/#enable-experimental-web-platform-features (or #canvas-draw-element) in Chrome to try it. Falling back to a snapshot: the page is frozen at activation; close to unfreeze.",
  keyboardCursor: "Aim the tool with the arrow keys",
  keyboardCursorHint: "Arrows move, Enter uses the tool, Esc leaves aiming",
  keyboardMoved: "Aim at {x}, {y}",
  keyboardStruck: "Used {tool} at {x}, {y}",
};

/** Merge host overrides over the defaults. Tool overrides merge per id. */
export function resolveStrings(overrides?: Partial<DestroyerStrings>): DestroyerStrings {
  if (!overrides) return DEFAULT_STRINGS;
  return {
    ...DEFAULT_STRINGS,
    ...overrides,
    tools: { ...DEFAULT_STRINGS.tools, ...overrides.tools },
  };
}

/** Substitute `{name}` placeholders; unknown names are left as written. */
export function formatString(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? String(values[key]) : match,
  );
}

/** A tool's display name and hint, with any host override applied. */
export function toolStrings(
  strings: DestroyerStrings,
  tool: { id: string; name: string; hint: string },
): { name: string; hint: string } {
  const override = strings.tools?.[tool.id];
  return { name: override?.name ?? tool.name, hint: override?.hint ?? tool.hint };
}
