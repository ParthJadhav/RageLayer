import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DestroyerEngine } from "../src/engine.ts";
import { hammer } from "../src/tools.ts";
import {
  flushResizeObservers,
  pointerEvent,
  resetMediaMatches,
  setMediaMatch,
  setViewport,
  stubRect,
  trackGlobalListeners,
} from "./support/dom.mjs";

/**
 * Capture is switched off unless a test is specifically about it: it reaches
 * for the DOM rasterizer, and every other behaviour here is independent of
 * whether a page snapshot exists.
 */
const BASE = { captureContent: false, postFX: false, harvestElements: false, textMask: false };

const engines = new Set();

function makeEngine(options = {}) {
  const engine = new DestroyerEngine({ ...BASE, ...options });
  engines.add(engine);
  return engine;
}

beforeEach(() => {
  setViewport(1024, 768, 2000);
});

afterEach(() => {
  for (const engine of engines) {
    if (!engine.disposed) engine.dispose();
  }
  engines.clear();
  document.body.replaceChildren();
});

describe("engine lifecycle", () => {
  test("mounting attaches an inert, non-announced overlay", () => {
    const engine = makeEngine();

    const container = engine.container;
    expect(container.parentElement).toBe(document.body);
    expect(container.getAttribute("aria-hidden")).toBe("true");
    // The overlay must not be swept into its own page capture.
    expect(container.hasAttribute("data-dd-ignore")).toBe(true);
    // With no tool selected the page underneath stays fully usable.
    expect(container.style.pointerEvents).toBe("none");
  });

  test("a custom target hosts the overlay instead of the body", () => {
    const host = document.createElement("section");
    document.body.appendChild(host);

    const engine = makeEngine({ target: host });

    expect(engine.container.parentElement).toBe(host);
  });

  test("dispose removes the overlay, fires once, and is idempotent", () => {
    const engine = makeEngine();
    let disposals = 0;
    engine.on("dispose", () => disposals++);

    engine.dispose();
    engine.dispose();

    expect(disposals).toBe(1);
    expect(engine.container.parentElement).toBeNull();
    expect(document.body.contains(engine.container)).toBe(false);
  });

  test("dispose detaches its window and document listeners", () => {
    const listeners = trackGlobalListeners();
    try {
      const engine = makeEngine();
      expect(listeners.outstanding).toBeGreaterThan(0);

      engine.dispose();

      expect(listeners.outstanding).toBe(0);
    } finally {
      listeners.restore();
    }
  });

  test("the overlay is sized to the document, not the viewport", () => {
    const engine = makeEngine();

    expect(engine.width).toBe(1024);
    // The document scrolls well past the viewport; damage has to reach all of it.
    expect(engine.height).toBe(2000);
    expect(engine.container.style.height).toBe("2000px");
  });

  test("event subscriptions can be cancelled", () => {
    const engine = makeEngine();
    let calls = 0;
    const off = engine.on("toolchange", () => calls++);

    engine.registerTool(hammer);
    engine.setTool("hammer");
    expect(calls).toBe(1);

    off();
    engine.setTool(null);
    expect(calls).toBe(1);
  });
});

describe("tool registration", () => {
  test("registering and selecting a tool arms the overlay", () => {
    const engine = makeEngine();
    engine.registerTool(hammer);

    expect(engine.getTools().map((tool) => tool.id)).toEqual(["hammer"]);
    expect(engine.tool).toBeNull();

    engine.setTool("hammer");

    expect(engine.tool?.id).toBe("hammer");
    // An armed overlay swallows pointer input and suppresses touch scrolling.
    expect(engine.container.style.pointerEvents).toBe("auto");
    expect(engine.container.style.touchAction).toBe("none");
  });

  test("selecting an unknown id deselects rather than throwing", () => {
    const engine = makeEngine();
    engine.registerTool(hammer);
    engine.setTool("hammer");

    engine.setTool("no-such-tool");

    expect(engine.tool).toBeNull();
    expect(engine.container.style.pointerEvents).toBe("none");
  });

  test("registerTools chains and accepts any iterable", () => {
    const engine = makeEngine();
    const result = engine.registerTools(new Set([hammer]));

    expect(result).toBe(engine);
    expect(engine.getTools()).toHaveLength(1);
  });

  test("unregistering the active tool deselects it first", () => {
    const engine = makeEngine();
    engine.registerTools([hammer]);
    engine.setTool("hammer");

    expect(engine.unregisterTool("hammer")).toBe(true);
    expect(engine.tool).toBeNull();
    expect(engine.getTools()).toHaveLength(0);
    expect(engine.unregisterTool("hammer")).toBe(false);
  });

  test("registration resets state a previous engine left in a shared tool", () => {
    let resets = 0;
    const tool = { id: "t", name: "T", icon: "x", hint: "h", reset: () => resets++ };

    const engine = makeEngine();
    engine.registerTool(tool);

    expect(resets).toBe(1);
  });
});

describe("pointer dispatch", () => {
  function armed(engine, tool) {
    engine.registerTool(tool);
    engine.setTool(tool.id);
    stubRect(engine.container, { x: 0, y: 0, width: 800, height: 600 });
    return engine;
  }

  test("a press, drag and release reach the tool in order", () => {
    const seen = [];
    const tool = {
      id: "probe",
      name: "Probe",
      icon: "p",
      hint: "h",
      onDown: (_engine, event) => seen.push(["down", event.x, event.y]),
      onMove: (_engine, event) => seen.push(["move", event.x, event.y]),
      onUp: (_engine, event) => seen.push(["up", event.x, event.y]),
    };
    const engine = armed(makeEngine(), tool);

    engine.container.dispatchEvent(pointerEvent("pointerdown", 100, 120));
    engine.container.dispatchEvent(pointerEvent("pointermove", 140, 160));
    window.dispatchEvent(pointerEvent("pointerup", 140, 160));

    expect(seen.map((entry) => entry[0])).toEqual(["down", "move", "up"]);
    expect(seen[0].slice(1)).toEqual([100, 120]);
  });

  test("pointercancel releases the tool like a clean lift", () => {
    let ups = 0;
    const tool = {
      id: "probe",
      name: "Probe",
      icon: "p",
      hint: "h",
      onUp: () => ups++,
    };
    const engine = armed(makeEngine(), tool);

    engine.container.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    window.dispatchEvent(pointerEvent("pointercancel", 10, 10));

    expect(ups).toBe(1);
  });

  test("a non-primary pointer is ignored so multi-touch cannot double-fire", () => {
    let downs = 0;
    const tool = {
      id: "probe",
      name: "Probe",
      icon: "p",
      hint: "h",
      onDown: () => downs++,
    };
    const engine = armed(makeEngine(), tool);

    engine.container.dispatchEvent(pointerEvent("pointerdown", 10, 10, { isPrimary: false }));

    expect(downs).toBe(0);
  });

  test("switching tools mid-gesture releases the outgoing tool", () => {
    let ups = 0;
    const first = {
      id: "first",
      name: "First",
      icon: "1",
      hint: "h",
      onUp: () => ups++,
    };
    const second = { id: "second", name: "Second", icon: "2", hint: "h" };
    const engine = armed(makeEngine(), first);
    engine.registerTool(second);

    engine.container.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    engine.setTool("second");

    expect(ups).toBe(1);
  });
});

describe("pause and resume", () => {
  test("explicit pause and resume emit a single change each", () => {
    const engine = makeEngine();
    const states = [];
    engine.on("pausechange", () => states.push(engine.paused));

    engine.pause();
    engine.pause();
    engine.resume();
    engine.resume();

    expect(states).toEqual([true, false]);
  });

  test("a hidden document suspends the engine on mount", () => {
    withVisibility("hidden", () => {
      const engine = makeEngine();
      expect(engine.paused).toBe(true);
    });
  });

  test("pauseWhenHidden: false keeps a background tab running", () => {
    withVisibility("hidden", () => {
      const engine = makeEngine({ pauseWhenHidden: false });
      expect(engine.paused).toBe(false);
    });
  });
});

describe("layout tracking", () => {
  test("a late-loading page growing taller is observed and re-measured", () => {
    const engine = makeEngine();
    expect(engine.height).toBe(2000);

    setViewport(1024, 768, 3200);
    flushResizeObservers();

    expect(engine.height).toBe(3200);
    expect(engine.container.style.height).toBe("3200px");
  });

  test("a window resize re-measures the overlay", () => {
    const engine = makeEngine();

    setViewport(800, 600, 1500);
    window.dispatchEvent(new Event("resize"));

    expect(engine.width).toBe(800);
    expect(engine.height).toBe(1500);
  });
});

describe("history", () => {
  test("history is opt-in", () => {
    const engine = makeEngine();
    expect(engine.historyState).toEqual({
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0,
    });
    expect(engine.checkpoint()).toBe(false);
    expect(engine.undo()).toBe(false);
    expect(engine.redo()).toBe(false);
  });

  test("enabling history makes checkpoints undoable and redoable", () => {
    const engine = makeEngine({ history: true });
    let changes = 0;
    engine.on("historychange", () => changes++);

    expect(engine.checkpoint("first")).toBe(true);
    expect(engine.historyState.canUndo).toBe(true);

    expect(engine.undo()).toBe(true);
    expect(engine.historyState.canUndo).toBe(false);
    expect(engine.historyState.canRedo).toBe(true);

    expect(engine.redo()).toBe(true);
    expect(engine.historyState.canRedo).toBe(false);
    expect(changes).toBeGreaterThanOrEqual(3);
  });

  test("clearHistory drops both stacks", () => {
    const engine = makeEngine({ history: true });
    engine.checkpoint();
    engine.clearHistory();

    expect(engine.historyState.canUndo).toBe(false);
    expect(engine.historyState.canRedo).toBe(false);
  });
});

describe("page queries without capture", () => {
  test("an uncaptured page is solid everywhere", () => {
    const engine = makeEngine();

    expect(engine.pageOpacityAt(10, 10)).toBe(1);
    expect(engine.onPage(10, 10)).toBe(true);
    expect(engine.content).toBeNull();
  });
});

describe("reduced motion", () => {
  const QUERY = "(prefers-reduced-motion: reduce)";

  afterEach(resetMediaMatches);

  test("the system preference removes nonessential transitions by default", () => {
    setMediaMatch(QUERY, true);
    const engine = makeEngine();

    expect(engine.vignette.style.transition).toBe("none");
  });

  test("an explicit false keeps full motion even when the system asks to reduce", () => {
    setMediaMatch(QUERY, true);
    const engine = makeEngine({ reducedMotion: false });

    expect(engine.vignette.style.transition).not.toBe("none");
  });

  test("an explicit true reduces motion even when the system does not ask", () => {
    setMediaMatch(QUERY, false);
    const engine = makeEngine({ reducedMotion: true });

    expect(engine.vignette.style.transition).toBe("none");
  });
});

describe("sound", () => {
  test("sound is off unless the host opts in", () => {
    expect(makeEngine().sound.enabled).toBe(false);
    expect(makeEngine({ soundEnabled: true }).sound.enabled).toBe(true);
  });

  test("setSound toggles at runtime", () => {
    const engine = makeEngine();
    engine.setSound(true);
    expect(engine.sound.enabled).toBe(true);
    engine.setSound(false);
    expect(engine.sound.enabled).toBe(false);
  });
});

function withVisibility(state, body) {
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  try {
    body();
  } finally {
    delete document.visibilityState;
    if (descriptor) Object.defineProperty(Document.prototype, "visibilityState", descriptor);
  }
}
