import { runSafely } from "./callbacks";
import { defaultTools } from "./default-tools";
import { RageLayerEngine } from "./engine";
import type { RageLayerEngineOptions, Tool } from "./types";

/** Options shared by the vanilla helper and all framework adapters. */
export interface MountRageLayerOptions extends RageLayerEngineOptions {
  /** Tools to register. Defaults to the complete built-in toolset. */
  tools?: readonly Tool[];
  /** Tool selected after mounting. Defaults to `"hammer"`; use `null` for click-through. */
  initialTool?: string | null;
}

/**
 * Mount a ready-to-use engine with the built-in tools registered.
 *
 * This is the smallest useful browser API. Use `createRageLayer` when
 * opening and closing the engine from UI or framework lifecycle code.
 */
export function mountRageLayer(options: MountRageLayerOptions = {}) {
  if (typeof document === "undefined") {
    throw new Error("mountRageLayer() must be called in a browser");
  }

  const { tools: explicitTools, initialTool, ...engineOptions } = options;
  const tools = explicitTools ?? defaultTools;
  const selectedInitialTool = initialTool === undefined ? "hammer" : initialTool;
  if (selectedInitialTool !== null && !tools.some((tool) => tool.id === selectedInitialTool)) {
    throw new RangeError(`Unknown initial RageLayer tool: ${selectedInitialTool}`);
  }
  const engine = new RageLayerEngine(engineOptions);
  try {
    for (const tool of tools) engine.registerTool(tool);
    engine.setTool(selectedInitialTool);
    return engine;
  } catch (error) {
    engine.dispose();
    throw error;
  }
}

export interface RageLayerController {
  /** The mounted engine, or `null` while closed. */
  readonly engine: RageLayerEngine | null;
  readonly isOpen: boolean;
  open(): RageLayerEngine;
  close(): void;
  toggle(): RageLayerEngine | null;
  /** Subscribe to open/close changes. The callback runs immediately. */
  subscribe(listener: (engine: RageLayerEngine | null) => void): () => void;
}

/**
 * Create a lazy lifecycle controller. It does no browser work until `open()`
 * and is therefore safe to create while a framework is rendering on a server.
 */
export function createRageLayer(options: MountRageLayerOptions = {}): RageLayerController {
  let engine: RageLayerEngine | null = null;
  let detachDispose: (() => void) | null = null;
  const listeners = new Set<(engine: RageLayerEngine | null) => void>();

  const notify = () => {
    const current = engine;
    for (const listener of [...listeners]) {
      // A listener can synchronously open or close the controller. That newer
      // notification must not be followed by the stale state from this loop.
      if (engine !== current) break;
      if (listeners.has(listener)) runSafely(() => listener(current), "Lifecycle listener failed");
    }
  };

  const controller: RageLayerController = {
    get engine() {
      return engine;
    },
    get isOpen() {
      return engine !== null;
    },
    open() {
      if (engine) return engine;
      const mounted = mountRageLayer(options);
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
      runSafely(() => listener(engine), "Lifecycle listener failed");
      return () => listeners.delete(listener);
    },
  };

  return controller;
}
