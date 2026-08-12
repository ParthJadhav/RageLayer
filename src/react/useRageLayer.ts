"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DestroyerEngine } from "../engine";
import { createRageLayer, type MountRageLayerOptions, type RageLayerController } from "../mount";

export interface UseRageLayerResult {
  engine: DestroyerEngine | null;
  isOpen: boolean;
  open(): DestroyerEngine;
  close(): void;
  toggle(): DestroyerEngine | null;
}

/** Headless React binding for applications that provide their own controls. */
export function useRageLayer(options: MountRageLayerOptions = {}): UseRageLayerResult {
  const controllerRef = useRef<RageLayerController | null>(null);
  if (!controllerRef.current) controllerRef.current = createRageLayer(options);
  const [engine, setEngine] = useState<DestroyerEngine | null>(null);

  useEffect(() => {
    const controller = controllerRef.current!;
    const unsubscribe = controller.subscribe(setEngine);
    return () => {
      unsubscribe();
      controller.close();
    };
  }, []);

  const open = useCallback(() => controllerRef.current!.open(), []);
  const close = useCallback(() => controllerRef.current!.close(), []);
  const toggle = useCallback(() => controllerRef.current!.toggle(), []);

  return { engine, isOpen: engine !== null, open, close, toggle };
}
