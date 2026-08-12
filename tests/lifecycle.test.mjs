import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setViewport } from "./support/dom.mjs";

// Imported after the DOM harness so the engine sees a browser, the same way a
// real host does. `mount.test.mjs` covers the opposite case deliberately.
const { createRageLayer, mountRageLayer } = await import("../src/mount.ts");
const { baseTools, hammer } = await import("../src/tools.ts");
const { createElement, useState } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useRageLayer } = await import("../src/react/useRageLayer.ts");

/**
 * The lifecycle helpers are the smallest useful API and the one every adapter
 * is built on, so the contract worth pinning is the awkward part: opening
 * twice is idempotent, closing tears the overlay out of the page, and an
 * engine that disposes itself is noticed by the controller that owns it.
 */

const engines = new Set();

beforeEach(() => setViewport(1024, 768, 2000));

afterEach(() => {
  for (const engine of engines) {
    if (!engine.disposed) engine.dispose();
  }
  engines.clear();
  document.body.replaceChildren();
});

function track(engine) {
  if (engine) engines.add(engine);
  return engine;
}

describe("mountRageLayer", () => {
  test("mounting registers the full toolset and selects the hammer", () => {
    const engine = track(mountRageLayer({ captureContent: false }));

    expect(engine.getTools().length).toBeGreaterThan(1);
    expect(engine.tool?.id).toBe("hammer");
    expect(document.body.contains(engine.container)).toBe(true);
  });

  test("an explicit toolset replaces the defaults", () => {
    const engine = track(
      mountRageLayer({ captureContent: false, tools: [hammer], initialTool: "hammer" }),
    );

    expect(engine.getTools().map((tool) => tool.id)).toEqual(["hammer"]);
  });

  test("a loadout selects its own first tool", () => {
    const engine = track(mountRageLayer({ captureContent: false, loadout: "precision" }));

    expect(engine.tool?.id).toBe(engine.getTools()[0].id);
  });

  test("initialTool: null mounts click-through", () => {
    const engine = track(mountRageLayer({ captureContent: false, initialTool: null }));

    expect(engine.tool).toBeNull();
    expect(engine.container.style.pointerEvents).toBe("none");
  });

  test("an unknown initial tool fails loudly and leaves nothing mounted", () => {
    // Silently ignoring it would leave a toolbar pointing at a tool that does
    // nothing, which is far harder to diagnose than an error at mount.
    const before = document.body.childElementCount;

    expect(() => mountRageLayer({ captureContent: false, initialTool: "no-such-tool" })).toThrow(
      "Unknown initial RageLayer tool",
    );

    expect(document.body.childElementCount).toBe(before);
  });
});

describe("createRageLayer", () => {
  test("nothing is created until open()", () => {
    const controller = createRageLayer({ captureContent: false });

    expect(controller.engine).toBeNull();
    expect(controller.isOpen).toBe(false);
    expect(document.body.childElementCount).toBe(0);
  });

  test("open, toggle and close move through the expected states", () => {
    const controller = createRageLayer({ captureContent: false, tools: baseTools });

    const engine = track(controller.open());
    expect(controller.isOpen).toBe(true);
    // Opening again is idempotent rather than mounting a second overlay.
    expect(controller.open()).toBe(engine);

    expect(controller.toggle()).toBeNull();
    expect(controller.isOpen).toBe(false);
    expect(engine.disposed).toBe(true);
    expect(document.body.contains(engine.container)).toBe(false);

    track(controller.toggle());
    expect(controller.isOpen).toBe(true);
  });

  test("subscribers see the current engine immediately and on every change", () => {
    const controller = createRageLayer({ captureContent: false });
    const seen = [];
    const unsubscribe = controller.subscribe((engine) => seen.push(engine));

    expect(seen).toEqual([null]);

    const engine = track(controller.open());
    expect(seen[1]).toBe(engine);

    controller.close();
    expect(seen[2]).toBeNull();

    unsubscribe();
    track(controller.open());
    expect(seen).toHaveLength(3);
  });

  test("an engine disposed from underneath is noticed by the controller", () => {
    // A host can call `engine.dispose()` directly; the controller must not go
    // on reporting itself open with a dead engine.
    const controller = createRageLayer({ captureContent: false });
    const engine = track(controller.open());

    engine.dispose();

    expect(controller.isOpen).toBe(false);
    expect(controller.engine).toBeNull();
  });

  test("closing when already closed is a no-op", () => {
    const controller = createRageLayer({ captureContent: false });

    expect(controller.close()).toBeUndefined();
    expect(controller.isOpen).toBe(false);
  });
});

describe("the headless React hook", () => {
  function render(component) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(component)));
    return {
      host,
      unmount: () => act(() => root.unmount()),
    };
  }

  test("toggling from a host control opens and closes the engine", () => {
    let destroyer;
    function Consumer() {
      destroyer = useRageLayer({ captureContent: false, tools: [hammer] });
      return createElement("span", null, destroyer.isOpen ? "open" : "closed");
    }

    const { host, unmount } = render(Consumer);
    expect(host.textContent).toBe("closed");

    act(() => {
      track(destroyer.toggle());
    });
    expect(host.textContent).toBe("open");

    act(() => destroyer.close());
    expect(host.textContent).toBe("closed");

    unmount();
  });

  test("unmounting closes the engine it opened", () => {
    let destroyer;
    function Consumer() {
      destroyer = useRageLayer({ captureContent: false, tools: [hammer] });
      return null;
    }

    const { unmount } = render(Consumer);
    let engine;
    act(() => {
      engine = track(destroyer.open());
    });
    expect(engine.disposed).toBe(false);

    unmount();

    expect(engine.disposed).toBe(true);
  });
});
