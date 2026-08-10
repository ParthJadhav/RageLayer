import type { DestroyerEngine } from "../engine";
import {
  createDesktopDestroyer,
  type DesktopDestroyerController,
  type MountDesktopDestroyerOptions,
} from "../mount";

export interface DesktopDestroyerActionOptions extends MountDesktopDestroyerOptions {
  /** Close on a second click. Defaults to true. */
  toggle?: boolean;
}

export interface DesktopDestroyerActionReturn {
  update(options?: DesktopDestroyerActionOptions): void;
  destroy(): void;
}

export interface DesktopDestroyerChangeDetail {
  engine: DestroyerEngine | null;
  open: boolean;
}

export type DesktopDestroyerChangeEvent = CustomEvent<DesktopDestroyerChangeDetail>;

declare global {
  interface HTMLElementEventMap {
    desktopdestroyerchange: DesktopDestroyerChangeEvent;
  }
}

/**
 * Svelte action for turning any button into a lifecycle-safe launcher.
 *
 * It maintains `aria-pressed` and emits `desktopdestroyerchange` with the
 * current engine in `event.detail.engine`.
 */
export function desktopDestroyer(
  node: HTMLElement,
  options: DesktopDestroyerActionOptions = {},
): DesktopDestroyerActionReturn {
  const previousPressed = node.getAttribute("aria-pressed");
  let controller: DesktopDestroyerController;
  let unsubscribe: () => void;
  let toggles = true;

  const sync = (engine: ReturnType<DesktopDestroyerController["open"]> | null) => {
    node.setAttribute("aria-pressed", String(engine !== null));
    node.dispatchEvent(
      new CustomEvent<DesktopDestroyerChangeDetail>("desktopdestroyerchange", {
        detail: { engine, open: engine !== null },
      }),
    );
  };

  const configure = (next: DesktopDestroyerActionOptions) => {
    unsubscribe?.();
    controller?.close();
    const { toggle = true, ...mountOptions } = next;
    toggles = toggle;
    controller = createDesktopDestroyer(mountOptions);
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

export type { DesktopDestroyerController, MountDesktopDestroyerOptions } from "../mount";
export { createDesktopDestroyer } from "../mount";
