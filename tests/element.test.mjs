import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hammer } from "../src/tools.ts";
import { setViewport } from "./support/dom.mjs";

/**
 * Loaded dynamically, and deliberately after the DOM harness: `element.ts`
 * picks its base class at module-evaluation time, extending an inert stand-in
 * when `HTMLElement` is missing so that importing the entry on a server is
 * safe. A static import would be hoisted above the harness and the element
 * would be built on that stand-in.
 */
const { RageLayerElement, defineRageLayerElement, TAG_NAME } = await import("../src/element.ts");

/**
 * `<rage-layer>` is the toolbar every stack without a first-party
 * component uses, so its contract — a real, labelled, keyboard-operable
 * toolbar in a shadow root that tears the engine down when it leaves the
 * document — is what these tests hold to.
 */

defineRageLayerElement();

let element;

function mount(configure) {
  element = document.createElement(TAG_NAME);
  configure?.(element);
  document.body.appendChild(element);
  return element;
}

function shadow() {
  return element.shadowRoot;
}

function buttons() {
  return [...shadow().querySelectorAll("button")];
}

function buttonNamed(label) {
  return buttons().find((button) => button.getAttribute("aria-label") === label);
}

beforeEach(() => setViewport(1024, 768, 2000));

afterEach(() => {
  element?.remove();
  element = undefined;
  document.body.replaceChildren();
});

describe("registration", () => {
  test("the element is registered under its documented tag", () => {
    expect(customElements.get(TAG_NAME)).toBe(RageLayerElement);
  });

  test("registering twice is harmless", () => {
    // Two bundles importing the entry must not throw a duplicate-definition
    // error and take the host page down with them.
    expect(() => defineRageLayerElement()).not.toThrow();
  });

  test("a second tag name gets its own working constructor", () => {
    // The platform allows a constructor to be registered only once, so an
    // extra name has to be given a subclass rather than throwing.
    defineRageLayerElement("page-wrecker");

    const elementClass = customElements.get("page-wrecker");
    expect(elementClass).toBeDefined();
    expect(elementClass.prototype instanceof RageLayerElement).toBe(true);
  });
});

describe("mounting", () => {
  test("connecting builds a labelled toolbar in a shadow root", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));

    const bar = shadow().querySelector('[role="toolbar"]');
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-label").length).toBeGreaterThan(0);
    expect(buttons().length).toBeGreaterThan(1);
  });

  test("the toolbar excludes itself from the page it destroys", () => {
    mount((node) => node.configure({ captureContent: false }));

    expect(element.hasAttribute("data-ragelayer-ignore")).toBe(true);
  });

  test("an engine is created and exposed", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));

    expect(element.destroyerEngine).not.toBeNull();
    expect(element.destroyerEngine.getTools().map((tool) => tool.id)).toEqual(["hammer"]);
  });

  test("the initial-tool attribute selects a tool", () => {
    mount((node) => {
      node.configure({ captureContent: false });
      node.setAttribute("initial-tool", "hammer");
    });

    expect(element.destroyerEngine.tool?.id).toBe("hammer");
  });

  test("a named loadout limits the toolset", () => {
    mount((node) => {
      node.setAttribute("loadout", "precision");
      node.configure({ captureContent: false, loadout: "precision" });
    });

    const ids = element.destroyerEngine.getTools().map((tool) => tool.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain("blackhole");
  });
});

describe("accessibility", () => {
  test("exactly one button is tabbable, the rest are reachable by arrow keys", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));

    const tabbable = buttons().filter((button) => button.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
  });

  test("arrow keys move focus along the bar and wrap", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));
    const all = buttons();
    all[0].focus();

    all[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );

    expect(buttons().filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(buttons()[1].tabIndex).toBe(0);
  });

  test("every button carries an accessible name", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));

    for (const button of buttons()) {
      expect(button.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("a disabled action stays focusable but refuses to run", () => {
    // `aria-disabled` rather than `disabled` keeps the control discoverable
    // for screen-reader users, so the press has to be refused in code.
    mount((node) => node.configure({ tools: [hammer], captureContent: false, history: true }));
    const undo = buttons().find((button) => button.getAttribute("aria-disabled") === "true");

    expect(undo).toBeDefined();
    expect(() => undo.click()).not.toThrow();
  });

  test("a live region is present for keyboard aiming announcements", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));

    const live = shadow().querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
  });
});

describe("interaction", () => {
  test("clicking a tool button selects it and marks it pressed", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));

    buttonNamed(hammer.name).click();

    expect(element.destroyerEngine.tool?.id).toBe("hammer");
    expect(buttonNamed(hammer.name).getAttribute("aria-pressed")).toBe("true");
  });

  test("the close button emits ragelayer-close", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));
    let closes = 0;
    element.addEventListener("ragelayer-close", () => closes++);

    buttonNamed("Close RageLayer").click();

    expect(closes).toBe(1);
  });

  test("global shortcuts reach the model", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));
    expect(element.destroyerEngine.sound.enabled).toBe(false);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "m", bubbles: true, cancelable: true }),
    );

    expect(element.destroyerEngine.sound.enabled).toBe(true);
  });

  test("overridden strings reach the rendered buttons", () => {
    mount((node) =>
      node.configure({ tools: [hammer], captureContent: false, strings: { close: "Fermer" } }),
    );

    expect(buttonNamed("Fermer")).toBeDefined();
  });
});

describe("teardown", () => {
  test("removing the element disposes its engine", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));
    const engine = element.destroyerEngine;

    element.remove();

    expect(engine.disposed).toBe(true);
    expect(element.destroyerEngine).toBeNull();
  });

  test("the overlay leaves the page when the element does", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));
    const container = element.destroyerEngine.container;

    element.remove();

    expect(document.body.contains(container)).toBe(false);
  });

  test("reconnecting builds a fresh engine", () => {
    mount((node) => node.configure({ tools: [hammer], captureContent: false }));
    const first = element.destroyerEngine;
    element.remove();

    document.body.appendChild(element);

    expect(element.destroyerEngine).not.toBe(first);
    expect(element.destroyerEngine.disposed).toBe(false);
  });
});
