import { describe, expect, test } from "bun:test";
import { defaultTools } from "../src/default-tools.ts";
import { heavyTools } from "../src/heavy-tools.ts";
import { loadAdvancedTools, loadBaseTools, loadDefaultTools, loadHeavyTools } from "../src/lazy.ts";
import { baseTools } from "../src/tools.ts";

const ids = (tools) => tools.map((tool) => tool.id);

describe("split and lazy toolsets", () => {
  test("every built-in hint starts with its primary gesture", () => {
    for (const tool of defaultTools) expect(tool.hint).toMatch(/^(click|hold|drag)\b/);
  });

  test("the default toolbar holds every split set once, with the broom last", () => {
    const split = [...ids(baseTools), ...ids(heavyTools), ...ids(advancedTools)];
    expect(new Set(split).size).toBe(split.length);
    expect([...ids(defaultTools)].sort()).toEqual([...split].sort());
    expect(ids(defaultTools).slice(0, 2)).toEqual(["hammer", "gun"]);
    expect(ids(defaultTools).at(-1)).toBe("broom");
  });

  test("every built-in has scalable procedural art and a unique id", () => {
    expect(defaultTools.every((tool) => typeof tool.art === "function")).toBe(true);
    expect(new Set(ids(defaultTools)).size).toBe(defaultTools.length);
  });

  test("lazy loaders return independent arrays without mutating module presets", async () => {
    const [base, heavy, advanced, all] = await Promise.all([
      loadBaseTools(),
      loadHeavyTools(),
      loadAdvancedTools(),
      loadDefaultTools(),
    ]);
    expect(ids(base)).toEqual(ids(baseTools));
    expect(ids(heavy)).toEqual(ids(heavyTools));
    expect(ids(advanced)).toEqual(ids(advancedTools));
    expect(ids(all)).toEqual(ids(defaultTools));
    base.pop();
    heavy.pop();
    advanced.pop();
    all.pop();
    expect(ids(base)).toEqual(ids(baseTools).slice(0, -1));
    expect(ids(baseTools)).toHaveLength(base.length + 1);
    expect(ids(heavyTools)).toHaveLength(heavy.length + 1);
    expect(ids(advancedTools)).toHaveLength(advanced.length + 1);
    expect(ids(defaultTools)).toHaveLength(all.length + 1);
  });
});

import { advancedTools } from "../src/advanced-tools.ts";
