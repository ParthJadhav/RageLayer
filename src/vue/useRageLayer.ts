import type { ComputedRef, ShallowRef } from "vue";
import { computed, onScopeDispose, shallowRef } from "vue";
import type { RageLayerEngine } from "../engine";
import { createRageLayer, type MountRageLayerOptions } from "../mount";

export interface UseRageLayerResult {
  engine: ShallowRef<RageLayerEngine | null>;
  isOpen: ComputedRef<boolean>;
  open(): RageLayerEngine;
  close(): void;
  toggle(): RageLayerEngine | null;
}

/** Vue composable for a custom launcher or toolbar. Safe to create during SSR. */
export function useRageLayer(options: MountRageLayerOptions = {}): UseRageLayerResult {
  const controller = createRageLayer(options);
  const engine = shallowRef<RageLayerEngine | null>(null);
  const unsubscribe = controller.subscribe((next) => {
    engine.value = next;
  });

  onScopeDispose(() => {
    unsubscribe();
    controller.close();
  });

  return {
    engine,
    isOpen: computed(() => engine.value !== null),
    open: () => controller.open(),
    close: () => controller.close(),
    toggle: () => controller.toggle(),
  };
}
