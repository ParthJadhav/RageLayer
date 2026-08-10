import { defaultTools } from "./default-tools";
import { DestroyerEngine } from "./engine";
import { type BuiltInLoadoutId, resolveToolLoadout, type ToolLoadout } from "./loadouts";
import type { DestroyerOptions, Tool } from "./types";

/** Options shared by the vanilla helper and all framework adapters. */
export interface MountDesktopDestroyerOptions extends DestroyerOptions {
  /** Tools to register. Defaults to the complete built-in toolset. */
  tools?: readonly Tool[];
  /** Named or custom tool preset. Explicit `tools` take precedence. */
  loadout?: BuiltInLoadoutId | ToolLoadout;
  /** Tool selected after mounting. Defaults to `"hammer"`; use `null` for click-through. */
  initialTool?: string | null;
}

/**
 * Mount a ready-to-use engine with the built-in tools registered.
 *
 * This is the smallest useful browser API. Use `createDesktopDestroyer` when
 * opening and closing the engine from UI or framework lifecycle code.
 */
export function mountDesktopDestroyer(options: MountDesktopDestroyerOptions = {}) {
  if (typeof document === "undefined") {
    throw new Error("mountDesktopDestroyer() must be called in a browser");
  }

  const { tools: explicitTools, loadout, initialTool, ...engineOptions } = options;
  const tools = explicitTools ?? (loadout ? resolveToolLoadout(loadout) : defaultTools);
  const selectedInitialTool =
    initialTool === undefined ? (loadout ? (tools[0]?.id ?? null) : "hammer") : initialTool;
  const engine = new DestroyerEngine(engineOptions);
  for (const tool of tools) engine.registerTool(tool);

  if (selectedInitialTool !== null && !tools.some((tool) => tool.id === selectedInitialTool)) {
    engine.dispose();
    throw new RangeError(`Unknown initial Desktop Destroyer tool: ${selectedInitialTool}`);
  }
  engine.setTool(selectedInitialTool);
  return engine;
}

export interface DesktopDestroyerController {
  /** The mounted engine, or `null` while closed. */
  readonly engine: DestroyerEngine | null;
  readonly isOpen: boolean;
  open(): DestroyerEngine;
  close(): void;
  toggle(): DestroyerEngine | null;
  /** Subscribe to open/close changes. The callback runs immediately. */
  subscribe(listener: (engine: DestroyerEngine | null) => void): () => void;
}

/**
 * Create a lazy lifecycle controller. It does no browser work until `open()`
 * and is therefore safe to create while a framework is rendering on a server.
 */
export function createDesktopDestroyer(
  options: MountDesktopDestroyerOptions = {},
): DesktopDestroyerController {
  let engine: DestroyerEngine | null = null;
  let detachDispose: (() => void) | null = null;
  const listeners = new Set<(engine: DestroyerEngine | null) => void>();

  const notify = () => {
    for (const listener of listeners) listener(engine);
  };

  const controller: DesktopDestroyerController = {
    get engine() {
      return engine;
    },
    get isOpen() {
      return engine !== null;
    },
    open() {
      if (engine) return engine;
      const mounted = mountDesktopDestroyer(options);
      engine = mounted;
      detachDispose = mounted.on("dispose", () => {
        if (engine !== mounted) return;
        engine = null;
        detachDispose = null;
        notify();
      });
      notify();
      return mounted;
    },
    close() {
      if (!engine) return;
      const mounted = engine;
      engine = null;
      detachDispose?.();
      detachDispose = null;
      mounted.dispose();
      notify();
    },
    toggle() {
      if (engine) {
        controller.close();
        return null;
      }
      return controller.open();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(engine);
      return () => listeners.delete(listener);
    },
  };

  return controller;
}
