import { describe, expect, test } from "bun:test";
import { defaultTools } from "../src/default-tools.ts";
import { heavyTools } from "../src/heavy-tools.ts";
import { loadAdvancedTools, loadBaseTools, loadDefaultTools, loadHeavyTools } from "../src/lazy.ts";
import { baseTools } from "../src/tools.ts";

const ids = (tools) => tools.map((tool) => tool.id);

describe("split and lazy toolsets", () => {
  test("base, heavy, and advanced sets are disjoint and compose the official order", () => {
    expect(baseTools).toHaveLength(7);
    expect(heavyTools).toHaveLength(6);
    expect(advancedTools).toHaveLength(6);
    expect(new Set([...ids(baseTools), ...ids(heavyTools), ...ids(advancedTools)]).size).toBe(19);
    expect(ids(defaultTools)).toEqual([
      ...ids(baseTools.slice(0, -1)),
      ...ids(heavyTools),
      ...ids(advancedTools),
      baseTools.at(-1).id,
    ]);
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
    expect(baseTools).toHaveLength(7);
    expect(heavyTools).toHaveLength(6);
    expect(advancedTools).toHaveLength(6);
    expect(defaultTools).toHaveLength(19);
  });
});

import { advancedTools } from "../src/advanced-tools.ts";
