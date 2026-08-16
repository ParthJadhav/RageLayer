/**
 * `<rage-layer>` — the toolbar as a custom element.
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
 *     import "ragelayer/element";
 *     document.body.append(document.createElement("rage-layer"));
 */

import { RAGELAYER_IGNORE_ATTR } from "./capture";
import { defaultTools } from "./default-tools";
import { RageLayerEngine } from "./engine";
import type { RageLayerStrings } from "./strings";
import { type ToolbarButton, ToolbarModel, type ToolbarState } from "./toolbar";
import { toolbarIconElement } from "./toolbar-icons";
import type { RageLayerEngineOptions, Tool } from "./types";

export const TAG_NAME = "rage-layer";

const SHEET = `
:host {
  all: initial;
  position: fixed;
  inset: auto 0 max(16px, env(safe-area-inset-bottom)) 0;
  z-index: 2147483001;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  /* One token set drives the bar, the hint pill and the status chip, so
     contrast is tuned in a single place. */
  --rl-surface: rgba(14, 13, 12, 0.94);
  --rl-hairline: rgba(255, 255, 255, 0.1);
  --rl-ink: rgba(255, 255, 255, 0.74);
  --rl-accent: #ff7a28;
}
.bar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 2px;
  width: max-content;
  max-width: calc(100vw - 24px);
  margin: 0 auto;
  padding: 6px;
  flex-wrap: wrap;
  justify-content: center;
  border-radius: 18px;
  border: 1px solid var(--rl-hairline);
  background: var(--rl-surface);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.07) inset,
    0 20px 50px -16px rgba(0, 0, 0, 0.7), 0 4px 14px rgba(0, 0, 0, 0.3);
  animation: rise 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.guide {
  max-width: min(620px, calc(100vw - 32px));
  padding: 6px 14px;
  border: 1px solid var(--rl-hairline);
  border-radius: 999px;
  background: var(--rl-surface);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: 0 12px 32px -16px rgba(0, 0, 0, 0.7);
  color: rgba(255, 255, 255, 0.88);
  font-size: 12.5px;
  line-height: 1.35;
  text-align: center;
  text-wrap: pretty;
  pointer-events: none;
}
@keyframes rise {
  from { transform: translateY(14px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
button {
  all: unset;
  position: relative;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border-radius: 12px;
  cursor: pointer;
  font-size: 19px;
  line-height: 1;
  color: var(--rl-ink);
  transition: background 0.14s ease, color 0.14s ease, transform 0.14s ease;
}
button:hover:not([aria-disabled="true"]) { background: rgba(255, 255, 255, 0.09); color: #fff; }
button:active:not([aria-disabled="true"]) { transform: scale(0.93); }
button[aria-pressed="true"] {
  color: #fff;
  background: linear-gradient(180deg, rgba(255, 122, 40, 0.32), rgba(255, 122, 40, 0.18));
  box-shadow: 0 0 0 1px rgba(255, 150, 70, 0.5) inset, 0 5px 16px -6px rgba(255, 110, 30, 0.7);
}
/* A dock-style marker, so the selection survives the pointer moving away and
   the hover tint disappearing. */
button[aria-pressed="true"]::after {
  content: "";
  position: absolute;
  bottom: 3px;
  width: 12px;
  height: 2px;
  border-radius: 2px;
  background: var(--rl-accent);
}
/* A visible focus ring is the whole point for keyboard operation; never
   remove it, and keep it legible against both bar and active states. */
button:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
/* Disabled controls dim their ink rather than the whole button: an opacity
   wash over the dark bar left undo and redo close to invisible. */
button[aria-disabled="true"] { color: rgba(255, 255, 255, 0.26); cursor: default; }
button img { width: 28px; height: 28px; display: block; }
button svg { display: block; }
.divider {
  width: 1px;
  align-self: stretch;
  margin: 6px 7px;
  background: var(--rl-hairline);
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
  color: rgba(255, 255, 255, 0.78);
  font-size: 11px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  flex: 0 0 auto;
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
  border: 1px solid var(--rl-hairline);
  background: var(--rl-surface);
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
@media (max-width: 640px) {
  .guide { font-size: 14px; }
  .bar {
    width: calc(100vw - 24px);
    flex-wrap: nowrap;
    justify-content: flex-start;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .bar::-webkit-scrollbar { display: none; }
  /* Full 44px touch targets once the row scrolls instead of wrapping. */
  button { width: 44px; height: 44px; }
}
`;

export interface RageLayerElementConfig extends RageLayerEngineOptions {
  tools?: readonly Tool[];
  strings?: Partial<RageLayerStrings>;
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
 * The element fires `ragelayer-close` when the visitor closes the toolbar; hosts
 * usually remove the element in response.
 */
export class RageLayerElement extends ElementBase {
  static observedAttributes = ["initial-tool", "sound"];

  private engine: RageLayerEngine | null = null;
  private model: ToolbarModel | null = null;
  private unsubscribe: (() => void) | null = null;
  private bar!: HTMLDivElement;
  private guide!: HTMLDivElement;
  private live!: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];
  private restoringFocus = false;
  private previousFocus: HTMLElement | null = null;
  private config: RageLayerElementConfig = {};

  /** Set richer options than attributes can express, before connecting. */
  configure(config: RageLayerElementConfig) {
    this.config = config;
    if (this.isConnected) {
      this.teardown();
      this.setup();
    }
  }

  get rageLayerEngine(): RageLayerEngine | null {
    return this.engine;
  }

  connectedCallback() {
    // The toolbar is part of RageLayer, not part of the page it destroys.
    this.setAttribute(RAGELAYER_IGNORE_ATTR, "");
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
    this.guide = document.createElement("div");
    this.guide.className = "guide";
    this.guide.setAttribute("aria-hidden", "true");
    root.replaceChildren(style, this.live, this.guide, this.bar);

    const tools = this.config.tools ?? defaultTools;

    const engine = new RageLayerEngine({
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
      toolStyle: this.config.toolStyle,
      onClose: () => this.dispatchEvent(new CustomEvent("ragelayer-close", { bubbles: true })),
    });
    this.model = model;
    this.bar.setAttribute("aria-label", model.state.toolbarLabel);

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
    const current = this.buttons.indexOf(event.target as HTMLButtonElement);
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
    this.guide.textContent = state.hint ?? "";

    const focusedIndex = this.buttons.indexOf(this.shadowRoot?.activeElement as HTMLButtonElement);
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
      nodes.push(this.renderButton(button, index, index === state.focusIndex));
    }

    if (state.status) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.title = state.status.title;
      chip.setAttribute("role", "status");
      chip.setAttribute("aria-live", "polite");
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
    this.bar.replaceChildren(...nodes);
    if (focusedIndex >= 0) {
      // Rebuilding must not drop keyboard focus, but restoring it must also
      // not overwrite a pointer-previewed hint with the old focus index.
      this.restoringFocus = true;
      this.buttons[focusedIndex]?.focus();
      this.restoringFocus = false;
    }
  }

  private renderButton(button: ToolbarButton, index: number, tabbable: boolean): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.setAttribute("aria-label", button.label);
    element.title = button.title;
    element.tabIndex = tabbable ? 0 : -1;
    if (button.pressed !== undefined) element.setAttribute("aria-pressed", String(button.pressed));
    if (button.disabled) element.setAttribute("aria-disabled", "true");
    if (button.color) element.style.color = button.color;

    if (button.icon) {
      const image = document.createElement("img");
      image.src = button.icon;
      image.alt = "";
      element.append(image);
    } else if (button.iconPath) {
      element.append(toolbarIconElement(button.iconPath));
    } else {
      element.textContent = button.toolIcon ?? "";
    }

    element.addEventListener("click", () => {
      // `aria-disabled` keeps the control focusable and discoverable, so the
      // press has to be refused here rather than by the `disabled` attribute.
      if (button.disabled) return;
      button.run();
    });
    element.addEventListener("focus", () => {
      if (!this.restoringFocus) this.model?.setFocusIndex(index);
    });
    element.addEventListener("pointerenter", () => this.model?.setFocusIndex(index));
    element.addEventListener("pointerdown", () => this.model?.setFocusIndex(index));
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
export function defineRageLayerElement(tag = TAG_NAME) {
  if (typeof customElements === "undefined") return;
  if (customElements.get(tag)) return;
  const elementClass = registered.size === 0 ? RageLayerElement : class extends RageLayerElement {};
  try {
    customElements.define(tag, elementClass);
  } catch {
    // Another copy of this module registered the base constructor already;
    // a fresh subclass is always definable.
    customElements.define(tag, class extends RageLayerElement {});
  }
  registered.add(tag);
}
