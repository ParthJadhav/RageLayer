import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { effectScope } from "vue";
import { useRageKit as useReactRageKit } from "../src/react/useRageKit.ts";
import { rageKit } from "../src/svelte/index.ts";
import { useRageKit as useVueRageKit } from "../src/vue/index.ts";

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
      const destroyer = useReactRageKit({ initialTool: "hammer" });
      return createElement("span", null, destroyer.isOpen ? "open" : "closed");
    }

    expect(renderToString(createElement(Consumer))).toBe("<span>closed</span>");
  });

  test("the Vue composable starts closed and is safe inside an effect scope", () => {
    const scope = effectScope();
    const destroyer = scope.run(() =>
      useVueRageKit({ initialTool: "hammer", captureContent: false }),
    );

    expect(destroyer.engine.value).toBeNull();
    expect(destroyer.isOpen.value).toBe(false);
    expect(typeof destroyer.open).toBe("function");
    scope.stop();
  });

  test("the Svelte action reports state and restores host attributes", () => {
    const node = new FakeElement();
    node.setAttribute("aria-pressed", "mixed");
    const changes = [];
    node.addEventListener("ragekitchange", (event) => changes.push(event.detail));

    const action = rageKit(node, { initialTool: "hammer" });
    expect(node.getAttribute("aria-pressed")).toBe("false");
    expect(changes).toEqual([{ engine: null, open: false }]);

    action.update({ initialTool: "freeze", toggle: false });
    expect(changes).toHaveLength(2);
    action.destroy();
    expect(node.getAttribute("aria-pressed")).toBe("mixed");
  });
});
