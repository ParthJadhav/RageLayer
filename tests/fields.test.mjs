import { describe, expect, test } from "bun:test";
import { ScalarField } from "../src/fields.ts";

function frost() {
  return new ScalarField({ cell: 32, max: 1, initial: 0, outside: "zero" });
}

function fuel() {
  return new ScalarField({ cell: 26, max: 255, initial: 255, outside: "edge" });
}

describe("ScalarField", () => {
  test("stays unallocated until it is used", () => {
    const field = frost();
    expect(field.allocated).toBe(false);
    expect(field.byteLength).toBe(0);
    // Painting an unallocated field is a no-op rather than a crash.
    field.paintDisc(10, 10, 40, 1);
    expect(field.at(10, 10)).toBe(0);
  });

  test("paints a disc that falls off to nothing at the rim", () => {
    const field = frost();
    field.ensure(320, 320);
    field.paintDisc(160, 160, 64, 1);
    // The containing cell's centre is (176, 176), 22.6px off the disc centre.
    expect(field.at(160, 160)).toBeCloseTo(1 - Math.hypot(16, 16) / 64, 5);
    // A cell whose centre sits outside the radius is untouched.
    expect(field.at(160 + 96, 160)).toBe(0);
  });

  test("clamps to the configured range in both directions", () => {
    const field = frost();
    field.ensure(320, 320);
    field.paintDisc(160, 160, 64, 5);
    expect(field.at(160, 160)).toBe(1);
    field.paintDisc(160, 160, 64, -5);
    expect(field.at(160, 160)).toBe(0);
  });

  test("reads outside the grid per its policy", () => {
    const rime = frost();
    rime.ensure(320, 320);
    rime.paintDisc(10, 10, 64, 1);
    expect(rime.at(-40, -40)).toBe(0);

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
    const field = frost();
    field.ensure(320, 320);
    field.paintDisc(160, 160, 64, 1);
    field.ensure(640, 320);
    expect(field.at(160, 160)).toBe(0);
  });

  test("restores a snapshot only when the grid shape still matches", () => {
    const field = frost();
    field.ensure(320, 320);
    field.paintDisc(160, 160, 64, 1);
    const snapshot = field.snapshot();

    field.paintDisc(160, 160, 64, -1);
    expect(field.at(160, 160)).toBe(0);
    field.restore(snapshot);
    expect(field.at(160, 160)).toBeCloseTo(1 - Math.hypot(16, 16) / 64, 5);

    // A checkpoint taken before a reflow describes a different stride; it is
    // dropped rather than reinstated over a grid it no longer describes.
    field.ensure(640, 320);
    field.restore(snapshot);
    expect(field.allocated).toBe(false);
  });

  test("snapshots are independent copies", () => {
    const field = frost();
    field.ensure(320, 320);
    field.paintDisc(160, 160, 64, 1);
    const snapshot = field.snapshot();
    field.paintDisc(160, 160, 64, -1);
    expect(field.at(160, 160)).toBe(0);
    expect(snapshot?.values[5 * snapshot.cols + 5]).toBeGreaterThan(0);
  });
});
