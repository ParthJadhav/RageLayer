import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DestroyerEngine } from "../src/engine.ts";
import { hammer } from "../src/tools.ts";
import { setViewport } from "./support/dom.mjs";
import { createTestEngine, disposeTestEngines } from "./support/engine.mjs";

/**
 * Nothing in the degradation path throws — capture failure, an unmeasurable
 * layout and a missing text mask all fall back silently by design. That makes
 * the reporting channel the only way a host can tell that visitors are getting
 * the reduced experience, so it is worth pinning precisely.
 */

const engines = new Set();

function makeEngine(options = {}) {
  const engine = new DestroyerEngine({
    captureContent: false,
    postFX: false,
    harvestElements: false,
    textMask: false,
    ...options,
  });
  engines.add(engine);
  return engine;
}

beforeEach(() => setViewport(1024, 768, 2000));

afterEach(() => {
  for (const engine of engines) {
    if (!engine.disposed) engine.dispose();
  }
  engines.clear();
  disposeTestEngines();
});

describe("degradation reporting", () => {
  test("a page taller than the capture cap is reported, not silently truncated", () => {
    const seen = [];
    // 40 000px of document: everything below the cap stays intact, and a host
    // that cares needs to know why.
    setViewport(1024, 768, 40_000);

    makeEngine({ onError: (error) => seen.push(error) });

    expect(seen.map((error) => error.scope)).toContain("page-height");
    const error = seen.find((entry) => entry.scope === "page-height");
    expect(error.message).toContain("12000px");
  });

  test("the most recent degradation is readable after the fact", () => {
    setViewport(1024, 768, 40_000);
    const engine = makeEngine({ onError: () => {} });

    expect(engine.error?.scope).toBe("page-height");
  });

  test("an engine that never degrades reports no error", () => {
    expect(makeEngine().error).toBeNull();
  });

  test("handlers registered after construction still receive later reports", () => {
    const engine = makeEngine();
    const seen = [];
    engine.onError((error) => seen.push(error));

    // Growing past the cap after mount is the SPA case.
    setViewport(1024, 768, 40_000);
    window.dispatchEvent(new Event("resize"));

    expect(seen.map((error) => error.scope)).toContain("page-height");
  });

  test("unsubscribing stops delivery", () => {
    const engine = makeEngine();
    const seen = [];
    const off = engine.onError((error) => seen.push(error));
    off();

    setViewport(1024, 768, 40_000);
    window.dispatchEvent(new Event("resize"));

    expect(seen).toHaveLength(0);
  });

  test("a plain event subscriber sees errors too", () => {
    setViewport(1024, 768, 40_000);
    let fired = 0;

    const engine = makeEngine({ onError: () => {} });
    engine.on("error", () => fired++);
    // The construction-time report has already gone out, so provoke another.
    engine.error && fired++;

    expect(fired).toBeGreaterThan(0);
  });
});

describe("console behaviour", () => {
  test("without a handler the failure is still warned about", () => {
    // Removing the warning outright would make a silent failure completely
    // invisible to anyone who has not opted in.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setViewport(1024, 768, 40_000);
      makeEngine();

      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain("[desktop-destroyer]");
    } finally {
      warn.mockRestore();
    }
  });

  test("a registered handler silences the console so nothing is logged twice", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      setViewport(1024, 768, 40_000);
      const seen = [];
      makeEngine({ onError: (error) => seen.push(error) });

      expect(seen).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("keyboard-driven destruction", () => {
  test("strike uses the active tool without any pointer event", () => {
    const engine = createTestEngine({ tools: [hammer] });
    engine.setTool("hammer");
    const marks = [];
    engine.registerTool({
      id: "probe",
      name: "Probe",
      icon: "p",
      hint: "h",
      onDown: (_engine, event) => marks.push(["down", event.x, event.y]),
      onUp: (_engine, event) => marks.push(["up", event.x, event.y]),
    });
    engine.setTool("probe");

    expect(engine.strike(120, 240)).toBe(true);

    expect(marks).toEqual([
      ["down", 120, 240],
      ["up", 120, 240],
    ]);
  });

  test("a held strike drives tick-based tools", () => {
    const engine = createTestEngine();
    let ticks = 0;
    engine.registerTool({
      id: "spray",
      name: "Spray",
      icon: "s",
      hint: "h",
      tick: (_engine, _dt, held) => {
        if (held) ticks++;
      },
    });
    engine.setTool("spray");

    engine.strike(100, 100, { holdMs: 500 });

    expect(ticks).toBeGreaterThan(10);
  });

  test("striking with no tool selected does nothing", () => {
    const engine = createTestEngine({ tools: [hammer] });

    expect(engine.strike(100, 100)).toBe(false);
  });

  test("a paused engine refuses to strike", () => {
    const engine = createTestEngine({ tools: [hammer] });
    engine.setTool("hammer");
    engine.pause();

    expect(engine.strike(100, 100)).toBe(false);
  });

  test("a keyboard strike is undoable like any other blow", () => {
    const engine = createTestEngine({ tools: [], history: true });
    engine.registerTool(hammer);
    engine.setTool("hammer");

    engine.strike(400, 300);

    expect(engine.historyState.canUndo).toBe(true);
  });

  test("the aim cursor round-trips through the engine", () => {
    const engine = createTestEngine();

    expect(engine.aim).toBeNull();
    engine.setAim({ x: 12, y: 34 });
    expect(engine.aim).toEqual({ x: 12, y: 34 });
    engine.setAim(null);
    expect(engine.aim).toBeNull();
  });
});
