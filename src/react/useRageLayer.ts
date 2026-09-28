"use client";

import { useCallback, useEffect, useState } from "react";
import type { RageLayerEngine } from "../engine";
import { createRageLayer, type MountRageLayerOptions } from "../mount";

export interface UseRageLayerResult {
  engine: RageLayerEngine | null;
  isOpen: boolean;
  open(): RageLayerEngine;
  close(): void;
  toggle(): RageLayerEngine | null;
}

/** Headless React binding for applications that provide their own controls. */
export function useRageLayer(options: MountRageLayerOptions = {}): UseRageLayerResult {
  // Creating the controller is inert; only open() mounts the engine.
  const [controller] = useState(() => createRageLayer(options));
  const [engine, setEngine] = useState<RageLayerEngine | null>(null);

  useEffect(() => {
    const unsubscribe = controller.subscribe(setEngine);
    return () => {
      unsubscribe();
      controller.close();
    };
  }, [controller]);

  const open = useCallback(() => controller.open(), [controller]);
  const close = useCallback(() => controller.close(), [controller]);
  const toggle = useCallback(() => controller.toggle(), [controller]);

  return { engine, isOpen: engine !== null, open, close, toggle };
}
