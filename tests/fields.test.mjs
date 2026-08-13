import { describe, expect, test } from "bun:test";
import { ScalarField } from "../src/fields.ts";

function fuel() {
  return new ScalarField({ cell: 26, max: 255, initial: 255 });
}

describe("ScalarField", () => {
  test("stays unallocated until it is used", () => {
    const field = fuel();
    expect(field.allocated).toBe(false);
    expect(field.byteLength).toBe(0);
    field.addCross(10, 10, -40, 0);
    expect(field.at(10, 10)).toBe(255);
  });

  test("clamps to the configured range in both directions", () => {
    const field = fuel();
    field.ensure(320, 320);
    field.addCross(160, 160, -500, 0);
    expect(field.at(160, 160)).toBe(0);
    field.addCross(160, 160, 500, 0);
    expect(field.at(160, 160)).toBe(255);
  });

  test("off-grid reads clamp to the nearest fuel cell", () => {
    const wood = fuel();
    wood.ensure(320, 320);
    wood.addCross(10, 10, -255, 0);
    // "edge" reports the nearest cell: a flame just past the rim is still
    // burning the board it started on.
    expect(wood.at(-40, 10)).toBe(0);
  });

  test("addCross bleeds into the four neighbours only", () => {
    const wood = fuel();
    wood.ensure(260, 260);
    wood.addCross(130, 130, -100, 0.25);
    expect(wood.at(130, 130)).toBe(155);
    expect(wood.at(130 - 26, 130)).toBe(230);
    expect(wood.at(130, 130 - 26)).toBe(230);
    // Diagonals are untouched.
    expect(wood.at(130 - 26, 130 - 26)).toBe(255);
  });

  test("reset refills, release drops the allocation", () => {
    const wood = fuel();
    wood.ensure(260, 260);
    wood.addCross(130, 130, -200, 0);
    wood.reset();
    expect(wood.at(130, 130)).toBe(255);
    wood.release();
    expect(wood.allocated).toBe(false);
  });

  test("re-shapes when the document reflows", () => {
    const field = fuel();
    field.ensure(320, 320);
    field.addCross(160, 160, -100, 0);
    field.ensure(640, 320);
    expect(field.at(160, 160)).toBe(255);
  });

  test("restores a snapshot only when the grid shape still matches", () => {
    const field = fuel();
    field.ensure(320, 320);
    field.addCross(160, 160, -100, 0);
    const snapshot = field.snapshot();

    field.addCross(160, 160, -155, 0);
    expect(field.at(160, 160)).toBe(0);
    field.restore(snapshot);
    expect(field.at(160, 160)).toBe(155);

    // A checkpoint taken before a reflow describes a different stride; it is
    // dropped rather than reinstated over a grid it no longer describes.
    field.ensure(640, 320);
    field.restore(snapshot);
    expect(field.allocated).toBe(false);
  });

  test("snapshots are independent copies", () => {
    const field = fuel();
    field.ensure(320, 320);
    field.addCross(160, 160, -100, 0);
    const snapshot = field.snapshot();
    field.addCross(160, 160, -155, 0);
    expect(field.at(160, 160)).toBe(0);
    expect(snapshot?.values.some((value) => value < 255)).toBe(true);
  });
});
