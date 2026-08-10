/**
 * `<desktop-destroyer>` — the toolbar as a custom element.
 *
 * React gets a component; before this, every other stack got a headless
 * controller and a note to build the toolbar themselves, which meant
 * re-implementing the roving tabindex, the shortcut gating, focus restoration
 * and the status chip. A custom element is the one UI that Vue, Svelte,
 * Angular, Solid, Qwik, Astro and plain HTML can all use unchanged.
 *
 * The UI lives in a shadow root, so the host page's CSS cannot reach in and
 * these styles cannot leak out. All behaviour comes from `ToolbarModel`.
 *
 *     import "desktop-destroyer/element";
 *     document.body.append(document.createElement("desktop-destroyer"));
 */

import { DD_IGNORE_ATTR } from "./capture";
import { defaultTools } from "./default-tools";
import { DestroyerEngine } from "./engine";
import { type BuiltInLoadoutId, resolveToolLoadout } from "./loadouts";
import type { DestroyerStrings } from "./strings";
import { type ToolbarButton, ToolbarModel, type ToolbarState } from "./toolbar";
import type { DestroyerOptions, Tool } from "./types";

export const TAG_NAME = "desktop-destroyer";

const SHEET = `
:host {
  all: initial;
  position: fixed;
  inset: auto 0 0 0;
  z-index: 2147483001;
  display: block;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.bar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  max-width: calc(100vw - 24px);
  margin: 0 auto 16px;
  padding: 8px 10px;
  flex-wrap: wrap;
  justify-content: center;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(20, 18, 16, 0.82);
  backdrop-filter: blur(12px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  animation: rise 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
@keyframes rise {
  from { transform: translateY(14px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
button {
  all: unset;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  cursor: pointer;
  font-size: 19px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.92);
  transition: background 0.14s ease, transform 0.14s ease;
}
button:hover:not([aria-disabled="true"]) { background: rgba(255, 255, 255, 0.1); }
button:active:not([aria-disabled="true"]) { transform: scale(0.94); }
button[aria-pressed="true"] {
  background: rgba(220, 90, 31, 0.9);
  color: #fff;
}
/* A visible focus ring is the whole point for keyboard operation; never
   remove it, and keep it legible against both bar and active states. */
button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
button[aria-disabled="true"] { opacity: 0.38; cursor: default; }
button img { width: 30px; height: 30px; display: block; }
.divider {
  width: 1px;
  height: 26px;
  margin: 0 2px;
  background: rgba(255, 255, 255, 0.14);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
  padding: 0 10px;
  height: 28px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  white-space: nowrap;
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.dot.pending { animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
.flash {
  position: absolute;
  left: 50%;
  bottom: 100%;
  transform: translateX(-50%);
  margin-bottom: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(20, 18, 16, 0.92);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .bar { animation: none; }
  button { transition: none; }
  .dot.pending { animation: none; }
}
`;

export interface DesktopDestroyerElementConfig extends DestroyerOptions {
  tools?: readonly Tool[];
  loadout?: BuiltInLoadoutId;
  strings?: Partial<DestroyerStrings>;
}

/**
 * `class X extends HTMLElement` is evaluated the moment the module loads, so
 * on a server — a Next.js server component, a SvelteKit SSR bundle, a Node
 * smoke test — merely importing this entry would throw before anything could
 * guard it. Extending an inert stand-in there keeps the import side-effect
 * free; registration is separately skipped when `customElements` is missing,
 * so the class is never actually used outside a browser.
 */
const ElementBase: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

/**
 * The element fires `dd-close` when the visitor closes the toolbar; hosts
 * usually remove the element in response.
 */
export class DesktopDestroyerElement extends ElementBase {
  static observedAttributes = ["loadout", "initial-tool", "sound"];

  private engine: DestroyerEngine | null = null;
  private model: ToolbarModel | null = null;
  private unsubscribe: (() => void) | null = null;
  private bar!: HTMLDivElement;
  private live!: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  private previousFocus: HTMLElement | null = null;
  private config: DesktopDestroyerElementConfig = {};

  /** Set richer options than attributes can express, before connecting. */
  configure(config: DesktopDestroyerElementConfig) {
    this.config = config;
    if (this.isConnected) {
      this.teardown();
      this.setup();
    }
  }

  get destroyerEngine(): DestroyerEngine | null {
    return this.engine;
  }

  connectedCallback() {
    // The toolbar is part of the destroyer, not part of the page it destroys.
    this.setAttribute(DD_IGNORE_ATTR, "");
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this.setup();
  }

  disconnectedCallback() {
    this.teardown();
  }

  attributeChangedCallback() {
    if (!this.isConnected) return;
    this.teardown();
    this.setup();
  }

  private setup() {
    const root = this.shadowRoot;
    if (!root) return;

    const style = document.createElement("style");
    style.textContent = SHEET;
    this.bar = document.createElement("div");
    this.bar.className = "bar";
    this.bar.setAttribute("role", "toolbar");
    this.bar.setAttribute("aria-orientation", "horizontal");
    this.live = document.createElement("div");
    this.live.className = "sr-only";
    this.live.setAttribute("role", "status");
    this.live.setAttribute("aria-live", "polite");
    root.replaceChildren(style, this.live, this.bar);

    const loadout =
      (this.getAttribute("loadout") as BuiltInLoadoutId | null) ?? this.config.loadout;
    const tools = this.config.tools ?? (loadout ? resolveToolLoadout(loadout) : defaultTools);

    const engine = new DestroyerEngine({
      soundEnabled: this.hasAttribute("sound"),
      history: true,
      ...this.config,
    });
    for (const tool of tools) engine.registerTool(tool);
    const initialTool = this.getAttribute("initial-tool");
    if (initialTool) engine.setTool(initialTool);
    this.engine = engine;

    const model = new ToolbarModel(engine, {
      tools,
      strings: this.config.strings,
      onClose: () => this.dispatchEvent(new CustomEvent("dd-close", { bubbles: true })),
    });
    this.model = model;
    this.bar.setAttribute(
      "aria-label",
      model.state.buttons.length > 0 ? "Desktop Destroyer tools" : "Desktop Destroyer",
    );

    this.unsubscribe = model.subscribe((state) => this.render(state));
    this.bar.addEventListener("keydown", this.onBarKeyDown);
    window.addEventListener("keydown", this.onWindowKeyDown);

    // Focus moves into the toolbar so keyboard operation can begin at once,
    // and returns to wherever it came from when the element goes away.
    this.previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.buttons[0]?.focus();
  }

  private teardown() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bar?.removeEventListener("keydown", this.onBarKeyDown);
    window.removeEventListener("keydown", this.onWindowKeyDown);
    this.model?.destroy();
    this.model = null;
    this.engine?.dispose();
    this.engine = null;
    this.buttons = [];
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
  }

  private onWindowKeyDown = (event: KeyboardEvent) => {
    if (this.model?.handleKeyDown(event)) event.preventDefault();
  };

  /** Arrow keys move focus within the bar; they never leave it. */
  private onBarKeyDown = (event: KeyboardEvent) => {
    const model = this.model;
    if (!model) return;
    const count = this.buttons.length;
    if (count === 0) return;
    const current = this.buttons.findIndex((button) => button === event.target);
    if (current < 0) return;

    let next: number | null = null;
    if (event.key === "ArrowLeft") next = current - 1;
    else if (event.key === "ArrowRight") next = current + 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null) return;

    event.preventDefault();
    // Arrow keys inside the bar are navigation, not aiming.
    event.stopPropagation();
    model.setFocusIndex(next);
    this.buttons[((next % count) + count) % count]?.focus();
  };

  private render(state: ToolbarState) {
    this.live.textContent = state.announcement;

    const nodes: Node[] = [];
    this.buttons = [];
    let previousKind: ToolbarButton["kind"] | null = null;

    for (const [index, button] of state.buttons.entries()) {
      if (previousKind === "tool" && button.kind === "action") {
        const divider = document.createElement("div");
        divider.className = "divider";
        nodes.push(divider);
      }
      previousKind = button.kind;
      nodes.push(this.renderButton(button, index === state.focusIndex));
    }

    if (state.status) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.title = state.status.title;
      const dot = document.createElement("span");
      dot.className = state.status.color ? "dot" : "dot pending";
      if (state.status.color) dot.style.color = state.status.color;
      chip.append(dot, document.createTextNode(state.status.label));
      nodes.push(chip);
    }

    if (state.flash) {
      const flash = document.createElement("div");
      flash.className = "flash";
      flash.setAttribute("role", "status");
      flash.textContent = state.flash;
      nodes.push(flash);
    }

    // Focus survives the rebuild: replacing the bar's children while a button
    // is focused would otherwise drop focus to the body mid-interaction.
    const focusedIndex = this.buttons.findIndex(
      (button) => button === this.shadowRoot?.activeElement,
    );
    this.bar.replaceChildren(...nodes);
    if (focusedIndex >= 0) this.buttons[focusedIndex]?.focus();
  }

  private renderButton(button: ToolbarButton, tabbable: boolean): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.setAttribute("aria-label", button.label);
    element.title = button.title;
    element.tabIndex = tabbable ? 0 : -1;
    if (button.pressed !== undefined) element.setAttribute("aria-pressed", String(button.pressed));
    if (button.disabled) element.setAttribute("aria-disabled", "true");
    if (button.fontSize) element.style.fontSize = `${button.fontSize}px`;
    if (button.color) element.style.color = button.color;

    if (button.icon) {
      const image = document.createElement("img");
      image.src = button.icon;
      image.alt = "";
      element.append(image);
    } else {
      element.textContent = button.glyph ?? button.toolIcon ?? "";
    }

    element.addEventListener("click", () => {
      // `aria-disabled` keeps the control focusable and discoverable, so the
      // press has to be refused here rather than by the `disabled` attribute.
      if (button.disabled) return;
      button.run();
    });
    this.buttons.push(element);
    return element;
  }
}

/** Tags this module has registered, so a second name gets its own constructor. */
const registered = new Set<string>();

/**
 * Register the element.
 *
 * Safe to call repeatedly: two bundles importing the entry must not throw a
 * duplicate-definition error and take the host page down with them. Registering
 * under a second tag is also supported — the platform allows a constructor to
 * be used only once, so additional names get a trivial subclass rather than
 * failing.
 */
export function defineDesktopDestroyerElement(tag = TAG_NAME) {
  if (typeof customElements === "undefined") return;
  if (customElements.get(tag)) return;
  const elementClass =
    registered.size === 0 ? DesktopDestroyerElement : class extends DesktopDestroyerElement {};
  try {
    customElements.define(tag, elementClass);
  } catch {
    // Another copy of this module registered the base constructor already;
    // a fresh subclass is always definable.
    customElements.define(tag, class extends DesktopDestroyerElement {});
  }
  registered.add(tag);
}
