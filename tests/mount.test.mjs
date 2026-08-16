import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createRageLayer } from "../src/mount.ts";

describe("framework-neutral lifecycle helpers", () => {
  test("the lazy controller is safe without browser globals", () => {
    const rageLayer = createRageLayer();
    const states = [];
    const unsubscribe = rageLayer.subscribe((engine) => states.push(engine));

    expect(rageLayer.engine).toBeNull();
    expect(rageLayer.isOpen).toBe(false);
    expect(states).toEqual([null]);
    expect(rageLayer.close()).toBeUndefined();

    unsubscribe();
  });

  test("mounting on the server fails with an actionable error", () => {
    // Other test files register happy-dom globals for the whole process, and
    // bun test's file order is filesystem-dependent, so a bare environment
    // here is a matter of luck. Assert in a fresh process that has no DOM.
    const script = `
      const { createRageLayer, mountRageLayer } = await import("./src/mount.ts");
      for (const open of [() => mountRageLayer(), () => createRageLayer().open()]) {
        try {
          open();
          throw new Error("expected a server-side mount to throw");
        } catch (error) {
          if (!String(error.message).includes("must be called in a browser")) throw error;
        }
      }
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
