import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createRageKit } from "../src/mount.ts";

describe("framework-neutral lifecycle helpers", () => {
  test("the lazy controller is safe without browser globals", () => {
    const destroyer = createRageKit();
    const states = [];
    const unsubscribe = destroyer.subscribe((engine) => states.push(engine));

    expect(destroyer.engine).toBeNull();
    expect(destroyer.isOpen).toBe(false);
    expect(states).toEqual([null]);
    expect(destroyer.close()).toBeUndefined();

    unsubscribe();
  });

  test("mounting on the server fails with an actionable error", () => {
    // Other test files register happy-dom globals for the whole process, and
    // bun test's file order is filesystem-dependent, so a bare environment
    // here is a matter of luck. Assert in a fresh process that has no DOM.
    const script = `
      const { createRageKit, mountRageKit } = await import("./src/mount.ts");
      for (const open of [() => mountRageKit(), () => createRageKit().open()]) {
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
