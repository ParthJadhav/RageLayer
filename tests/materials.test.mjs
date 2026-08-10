import { describe, expect, test } from "bun:test";
import { BUILT_IN_MATERIALS, MaterialSystem } from "../src/materials.ts";

describe("material definitions", () => {
  test("built-ins express distinct physical behavior", () => {
    expect(BUILT_IN_MATERIALS.metal.conductivity).toBe(1);
    expect(BUILT_IN_MATERIALS.wood.flammability).toBe(1);
    expect(BUILT_IN_MATERIALS.glass.toughness).toBeLessThan(BUILT_IN_MATERIALS.stone.toughness);
    expect(BUILT_IN_MATERIALS.rubber.restitution).toBeGreaterThan(0.8);
  });

  test("custom definitions are normalized and chainable", () => {
    const materials = new MaterialSystem().register({
      id: "custom",
      label: "Custom",
      toughness: 0,
      density: -1,
      flammability: 2,
      conductivity: -1,
      corrosionResistance: 0.4,
      restitution: 1.5,
      color: "#fff",
    });
    expect(materials.get("custom")).toMatchObject({
      toughness: 0.05,
      density: 0.05,
      flammability: 1,
      conductivity: 0,
      restitution: 1,
    });
  });
});
