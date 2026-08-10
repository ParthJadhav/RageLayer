import { describe, expect, test } from "bun:test";
import { BUILT_IN_LOADOUTS, createToolLoadout, resolveToolLoadout } from "../src/loadouts.ts";

describe("tool loadouts", () => {
  test("built-ins are immutable, unique, and independently resolved", () => {
    for (const loadout of Object.values(BUILT_IN_LOADOUTS)) {
      expect(new Set(loadout.tools.map((tool) => tool.id)).size).toBe(loadout.tools.length);
      expect(Object.isFrozen(loadout.tools)).toBe(true);
    }
    const first = resolveToolLoadout("chaos");
    first.pop();
    expect(resolveToolLoadout("chaos").length).toBeGreaterThan(first.length);
  });

  test("custom loadouts reject duplicate tools", () => {
    const tool = { id: "x", name: "X", icon: "X", hint: "x" };
    expect(() => createToolLoadout("bad", "Bad", [tool, tool])).toThrow("Duplicate tool id");
  });
});
