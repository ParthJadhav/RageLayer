import type { RageLayerEngine } from "../engine";
import { createRageLayer, type MountRageLayerOptions, type RageLayerController } from "../mount";

export interface RageLayerActionOptions extends MountRageLayerOptions {
  /** Close on a second click. Defaults to true. */
  toggle?: boolean;
}

export interface RageLayerActionReturn {
  update(options?: RageLayerActionOptions): void;
  destroy(): void;
}

export interface RageLayerChangeDetail {
  engine: RageLayerEngine | null;
  open: boolean;
}

export type RageLayerChangeEvent = CustomEvent<RageLayerChangeDetail>;

declare global {
  interface HTMLElementEventMap {
    ragelayerchange: RageLayerChangeEvent;
  }
}

/**
 * Svelte action for turning any button into a lifecycle-safe launcher.
 *
 * It maintains `aria-pressed` and emits `ragelayerchange` with the
 * current engine in `event.detail.engine`.
 */
export function rageLayer(
  node: HTMLElement,
  options: RageLayerActionOptions = {},
): RageLayerActionReturn {
  const previousPressed = node.getAttribute("aria-pressed");
  let controller: RageLayerController;
  let unsubscribe: () => void;
  let toggles = true;

  const sync = (engine: ReturnType<RageLayerController["open"]> | null) => {
    node.setAttribute("aria-pressed", String(engine !== null));
    node.dispatchEvent(
      new CustomEvent<RageLayerChangeDetail>("ragelayerchange", {
        detail: { engine, open: engine !== null },
      }),
    );
  };

  const configure = (next: RageLayerActionOptions) => {
    unsubscribe?.();
    controller?.close();
    const { toggle = true, ...mountOptions } = next;
    toggles = toggle;
    controller = createRageLayer(mountOptions);
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

export type { MountRageLayerOptions, RageLayerController } from "../mount";
export { createRageLayer } from "../mount";
