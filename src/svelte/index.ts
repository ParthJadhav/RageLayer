import type { DestroyerEngine } from "../engine";
import { createRageKit, type MountRageKitOptions, type RageKitController } from "../mount";

export interface RageKitActionOptions extends MountRageKitOptions {
  /** Close on a second click. Defaults to true. */
  toggle?: boolean;
}

export interface RageKitActionReturn {
  update(options?: RageKitActionOptions): void;
  destroy(): void;
}

export interface RageKitChangeDetail {
  engine: DestroyerEngine | null;
  open: boolean;
}

export type RageKitChangeEvent = CustomEvent<RageKitChangeDetail>;

declare global {
  interface HTMLElementEventMap {
    ragekitchange: RageKitChangeEvent;
  }
}

/**
 * Svelte action for turning any button into a lifecycle-safe launcher.
 *
 * It maintains `aria-pressed` and emits `ragekitchange` with the
 * current engine in `event.detail.engine`.
 */
export function rageKit(
  node: HTMLElement,
  options: RageKitActionOptions = {},
): RageKitActionReturn {
  const previousPressed = node.getAttribute("aria-pressed");
  let controller: RageKitController;
  let unsubscribe: () => void;
  let toggles = true;

  const sync = (engine: ReturnType<RageKitController["open"]> | null) => {
    node.setAttribute("aria-pressed", String(engine !== null));
    node.dispatchEvent(
      new CustomEvent<RageKitChangeDetail>("ragekitchange", {
        detail: { engine, open: engine !== null },
      }),
    );
  };

  const configure = (next: RageKitActionOptions) => {
    unsubscribe?.();
    controller?.close();
    const { toggle = true, ...mountOptions } = next;
    toggles = toggle;
    controller = createRageKit(mountOptions);
    unsubscribe = controller.subscribe(sync);
  };

  const activate = () => {
    if (toggles) controller.toggle();
    else controller.open();
  };

  configure(options);
  node.addEventListener("click", activate);

  return {
    update(next = {}) {
      configure(next);
    },
    destroy() {
      node.removeEventListener("click", activate);
      unsubscribe();
      controller.close();
      if (previousPressed === null) node.removeAttribute("aria-pressed");
      else node.setAttribute("aria-pressed", previousPressed);
    },
  };
}

export type { MountRageKitOptions, RageKitController } from "../mount";
export { createRageKit } from "../mount";
