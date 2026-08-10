import { describe, expect, test } from "bun:test";
import { DestructionHistory } from "../src/history.ts";

const entry = (label, pixelCost = 10) => ({
  label,
  timestamp: 0,
  pixelCost,
  disposed: false,
  dispose() {
    this.disposed = true;
  },
});

describe("DestructionHistory", () => {
  test("moves current states between bounded undo and redo stacks", () => {
    const history = new DestructionHistory({ maxEntries: 2, maxPixels: 1_000_000 });
    const a = entry("a");
    const b = entry("b");
    const c = entry("c");
    history.push(a);
    history.push(b);
    history.push(c);
    expect(a.disposed).toBe(true);
    expect(history.state).toEqual({ canUndo: true, canRedo: false, undoDepth: 2, redoDepth: 0 });
    expect(history.undo(entry("current")).label).toBe("c");
    expect(history.state.canRedo).toBe(true);
    expect(history.redo(entry("after-undo")).label).toBe("current");
  });

  test("new work clears and disposes the redo branch", () => {
    const history = new DestructionHistory();
    history.push(entry("a"));
    const current = entry("current");
    history.undo(current);
    history.push(entry("branch"));
    expect(current.disposed).toBe(true);
    expect(history.state.canRedo).toBe(false);
  });

  test("an oversized checkpoint is rejected instead of exceeding the hard pixel cap", () => {
    const history = new DestructionHistory({ maxPixels: 1_000_000 });
    const huge = entry("huge", 1_000_001);
    expect(history.push(huge)).toBe(false);
    expect(huge.disposed).toBe(true);
    expect(history.state.canUndo).toBe(false);
  });
});
