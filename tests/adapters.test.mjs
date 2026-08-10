import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { effectScope } from "vue";
import { useDesktopDestroyer as useReactDesktopDestroyer } from "../src/react/useDesktopDestroyer.ts";
import { desktopDestroyer } from "../src/svelte/index.ts";
import { useDesktopDestroyer as useVueDesktopDestroyer } from "../src/vue/index.ts";

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
      const destroyer = useReactDesktopDestroyer({ initialTool: "hammer" });
      return createElement("span", null, destroyer.isOpen ? "open" : "closed");
    }

    expect(renderToString(createElement(Consumer))).toBe("<span>closed</span>");
  });

  test("the Vue composable starts closed and is safe inside an effect scope", () => {
    const scope = effectScope();
    const destroyer = scope.run(() =>
      useVueDesktopDestroyer({ initialTool: "hammer", captureContent: false }),
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
    node.addEventListener("desktopdestroyerchange", (event) => changes.push(event.detail));

    const action = desktopDestroyer(node, { initialTool: "hammer" });
    expect(node.getAttribute("aria-pressed")).toBe("false");
    expect(changes).toEqual([{ engine: null, open: false }]);

    action.update({ initialTool: "freeze", toggle: false });
    expect(changes).toHaveLength(2);
    action.destroy();
    expect(node.getAttribute("aria-pressed")).toBe("mixed");
  });
});
