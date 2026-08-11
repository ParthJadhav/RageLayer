import type { ComputedRef, ShallowRef } from "vue";
import { computed, onScopeDispose, shallowRef } from "vue";
import type { DestroyerEngine } from "../engine";
import { createRageKit, type MountRageKitOptions } from "../mount";

export interface UseRageKitResult {
  engine: ShallowRef<DestroyerEngine | null>;
  isOpen: ComputedRef<boolean>;
  open(): DestroyerEngine;
  close(): void;
  toggle(): DestroyerEngine | null;
}

/** Vue composable for a custom launcher or toolbar. Safe to create during SSR. */
export function useRageKit(options: MountRageKitOptions = {}): UseRageKitResult {
  const controller = createRageKit(options);
  const engine = shallowRef<DestroyerEngine | null>(null);
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
