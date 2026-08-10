import { describe, expect, test } from "bun:test";
import { ComboTracker } from "../src/combos.ts";

describe("ComboTracker", () => {
  test("detects an unordered nearby pair inside the time window", () => {
    const tracker = new ComboTracker();
    expect(tracker.record("water", 100, 100, 0)).toEqual([]);
    expect(tracker.record("electricity", 120, 115, 500)[0]).toMatchObject({
      id: "conductive-surge",
      first: "water",
      second: "electricity",
    });
  });

  test("rejects distant, expired, and cooldown-spammed interactions", () => {
    const tracker = new ComboTracker({ windowMs: 1_000, radius: 40, cooldownMs: 800 });
    tracker.record("acid", 0, 0, 0);
    expect(tracker.record("fire", 100, 100, 100)).toEqual([]);
    expect(tracker.record("fire", 0, 0, 1_100)).toEqual([]);
    expect(tracker.record("acid", 0, 0, 1_200)).toHaveLength(1);
    expect(tracker.record("fire", 0, 0, 1_250)).toEqual([]);
    expect(tracker.record("acid", 0, 0, 1_300)).toEqual([]);
  });

  test("clear removes prior interactions", () => {
    const tracker = new ComboTracker();
    tracker.record("glitch", 10, 10, 0);
    tracker.clear();
    expect(tracker.record("electricity", 10, 10, 10)).toEqual([]);
  });
});
