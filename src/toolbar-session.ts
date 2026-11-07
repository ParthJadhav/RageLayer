import type { RageLayerEngine } from "./engine";
import { mountRageLayer } from "./mount";
import type { RageLayerStrings } from "./strings";
import { ToolbarModel } from "./toolbar";
import type { RageLayerEngineOptions, Tool } from "./types";

/**
 * Everything a ready-made toolbar (React, Vue, or the custom element) owns
 * while it is open, independent of how it renders.
 */
export interface ToolbarSession {
  readonly engine: RageLayerEngine;
  readonly model: ToolbarModel;
  /** Dispose the engine and model, and hand focus back to where it was. */
  close(): void;
}

export interface ToolbarSessionOptions {
  engineOptions: RageLayerEngineOptions;
  tools: readonly Tool[];
  strings?: Partial<RageLayerStrings>;
  onClose?(): void;
}

/**
 * Mount an engine with no tool selected, drive it from a `ToolbarModel`, and
 * route page-wide keyboard shortcuts to the model until `close`.
 */
export function openToolbarSession(options: ToolbarSessionOptions): ToolbarSession {
  const { engineOptions, tools } = options;
  const engine = mountRageLayer({ ...engineOptions, tools, initialTool: null });
  const model = new ToolbarModel(engine, {
    tools,
    strings: options.strings,
    toolStyle: engineOptions.toolStyle,
    onClose: options.onClose,
  });
  const previousFocus =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (model.handleKeyDown(event)) event.preventDefault();
  };
  window.addEventListener("keydown", onKeyDown);

  return {
    engine,
    model,
    close() {
      window.removeEventListener("keydown", onKeyDown);
      model.destroy();
      engine.dispose();
      if (previousFocus?.isConnected) previousFocus.focus();
    },
  };
}

/**
 * The roving-focus index a key pressed inside the toolbar moves to, or null
 * when the key is not toolbar navigation. Arrows wrap around the row.
 */
export function rovingFocusTarget(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  let next: number;
  if (key === "ArrowLeft") next = current - 1;
  else if (key === "ArrowRight") next = current + 1;
  else if (key === "Home") next = 0;
  else if (key === "End") next = count - 1;
  else return null;
  return ((next % count) + count) % count;
}
