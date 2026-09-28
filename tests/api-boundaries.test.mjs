import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createRageLayer, mountRageLayer } from "../src/mount.ts";
import { setViewport } from "./support/dom.mjs";

const engines = new Set();
const options = { captureContent: false, postFX: false, initialTool: null };
const tool = (reset) => ({ id: "probe", name: "Probe", icon: "p", hint: "test", reset });

afterEach(() => {
  for (const engine of engines) engine.dispose();
  engines.clear();
  document.body.replaceChildren();
});

function mount(extra = {}) {
  setViewport(800, 600, 600);
  const engine = mountRageLayer({ ...options, ...extra });
  engines.add(engine);
  return engine;
}

describe("host failure boundaries", () => {
  test("an error observer removed during notification is not called afterward", () => {
    const engine = mount();
    let calls = 0;
    let off;
    engine.onError(() => off());
    off = engine.onError(() => calls++);
    setViewport(800, 600, 40_000);
    window.dispatchEvent(new Event("resize"));
    expect(calls).toBe(0);
  });
  test("a throwing onError cannot abort constructor cleanup registration", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setViewport(800, 600, 40_000);
      let engine;
      expect(() => {
        engine = mountRageLayer({
          ...options,
          onError: () => {
            throw new Error("reporter failed");
          },
        });
        engines.add(engine);
      }).not.toThrow();
      expect(engine.error.scope).toBe("page-height");
      engine.dispose();
      expect(document.body.contains(engine.container)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a lifecycle listener can close during open without leaving stale state in peers", () => {
    const controller = createRageLayer(options);
    controller.subscribe((engine) => {
      if (engine) controller.close();
    });
    const seen = [];
    controller.subscribe((engine) => seen.push(engine));
    engines.add(controller.open());
    expect(controller.isOpen).toBe(false);
    expect(seen.every((engine) => engine === null)).toBe(true);
  });
  test("a failed tool initialization rolls back the mounted engine", () => {
    setViewport(800, 600, 600);
    const before = document.body.childElementCount;
    let failedEngine;
    expect(() =>
      mountRageLayer({
        ...options,
        tools: [
          tool((engine) => {
            failedEngine = engine;
            throw new Error("initialization failed");
          }),
        ],
      }),
    ).toThrow("initialization failed");
    engines.add(failedEngine);
    expect(document.body.childElementCount).toBe(before);
    expect(failedEngine.disposed).toBe(true);
  });

  test("one broken disposal subscriber cannot prevent cleanup or other subscribers", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const engine = mount();
      void engine.damageCtx;
      let notified = false;
      engine.on("dispose", () => {
        throw new Error("host failed");
      });
      engine.on("dispose", () => {
        notified = true;
      });
      expect(() => engine.dispose()).not.toThrow();
      expect(notified).toBe(true);
      expect(engine.damageCtx.canvas.width).toBe(0);
      expect(engine.getTools()).toEqual([]);
      expect(document.body.contains(engine.container)).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("a broken custom reset cannot retain the other tools on disposal", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let resets = 0;
      const engine = mount({
        tools: [
          tool(() => {
            if (++resets > 1) throw new Error("reset failed");
          }),
        ],
      });
      let cleaned = false;
      engine.registerTool({
        ...tool(() => {
          cleaned = true;
        }),
        id: "second",
      });
      cleaned = false;
      expect(() => engine.dispose()).not.toThrow();
      expect(cleaned).toBe(true);
      expect(engine.getTools()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a broken lifecycle observer does not hide an open or closed engine from peers", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const controller = createRageLayer(options);
      let armed = false;
      controller.subscribe(() => {
        if (armed) throw new Error("observer failed");
      });
      const seen = [];
      controller.subscribe((engine) => seen.push(engine));
      armed = true;
      let engine;
      expect(() => {
        engine = controller.open();
        engines.add(engine);
      }).not.toThrow();
      expect(seen.at(-1)).toBe(engine);
      expect(() => controller.close()).not.toThrow();
      expect(seen.at(-1)).toBeNull();
      expect(controller.isOpen).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
