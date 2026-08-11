"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DestroyerEngine } from "../engine";
import { createRageKit, type MountRageKitOptions, type RageKitController } from "../mount";

export interface UseRageKitResult {
  engine: DestroyerEngine | null;
  isOpen: boolean;
  open(): DestroyerEngine;
  close(): void;
  toggle(): DestroyerEngine | null;
}

/** Headless React binding for applications that provide their own controls. */
export function useRageKit(options: MountRageKitOptions = {}): UseRageKitResult {
  const controllerRef = useRef<RageKitController | null>(null);
  if (!controllerRef.current) controllerRef.current = createRageKit(options);
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
