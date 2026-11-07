import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useRageLayer as useReactRageLayer } from "../src/react/useRageLayer.ts";
import { rageLayer } from "../src/svelte/index.ts";
import "./support/dom.mjs";

// Bun shares one module cache across test files, and @vue/runtime-dom captures
// `document` when it first evaluates; a static import of a CommonJS package
// runs before this file's other imports. Loaded without a DOM, Vue would keep a
// null document and break every later Vue component test whenever this file
// happens to run first.
const { effectScope } = await import("vue");
const { useRageLayer: useVueRageLayer } = await import("../src/vue/index.ts");

class FakeElement extends EventTarget {
  attributes = new Map();

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }
}

describe("framework adapters", () => {
  test("the headless React hook is safe during server rendering", () => {
    function Consumer() {
      const rageLayer = useReactRageLayer({ initialTool: "hammer" });
      return createElement("span", null, rageLayer.isOpen ? "open" : "closed");
    }

    expect(renderToString(createElement(Consumer))).toBe("<span>closed</span>");
  });

  test("the Vue composable starts closed and is safe inside an effect scope", () => {
    const scope = effectScope();
    const rageLayer = scope.run(() =>
      useVueRageLayer({ initialTool: "hammer", captureContent: false }),
    );

    expect(rageLayer.engine.value).toBeNull();
    expect(rageLayer.isOpen.value).toBe(false);
    expect(typeof rageLayer.open).toBe("function");
    scope.stop();
  });

  test("the Svelte action reports state and restores host attributes", () => {
    const node = new FakeElement();
    node.setAttribute("aria-pressed", "mixed");
    const changes = [];
    node.addEventListener("ragelayerchange", (event) => changes.push(event.detail));

    const action = rageLayer(node, { initialTool: "hammer" });
    expect(node.getAttribute("aria-pressed")).toBe("false");
    expect(changes).toEqual([{ engine: null, open: false }]);

    action.update({ initialTool: "water", toggle: false });
    expect(changes).toHaveLength(2);
    action.destroy();
    expect(node.getAttribute("aria-pressed")).toBe("mixed");
  });
});
