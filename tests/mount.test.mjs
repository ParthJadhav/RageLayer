import { describe, expect, test } from "bun:test";
import { createDesktopDestroyer, mountDesktopDestroyer } from "../src/mount.ts";

describe("framework-neutral lifecycle helpers", () => {
  test("the lazy controller is safe without browser globals", () => {
    const destroyer = createDesktopDestroyer();
    const states = [];
    const unsubscribe = destroyer.subscribe((engine) => states.push(engine));

    expect(destroyer.engine).toBeNull();
    expect(destroyer.isOpen).toBe(false);
    expect(states).toEqual([null]);
    expect(destroyer.close()).toBeUndefined();

    unsubscribe();
  });

  test("mounting on the server fails with an actionable error", () => {
    expect(() => mountDesktopDestroyer()).toThrow("must be called in a browser");
    expect(() => createDesktopDestroyer().open()).toThrow("must be called in a browser");
  });
});
