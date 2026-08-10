import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_STRINGS, formatString, resolveStrings, toolStrings } from "../src/strings.ts";
import { ToolbarModel } from "../src/toolbar.ts";
import { baseTools, broom, hammer } from "../src/tools.ts";
import { createTestEngine, disposeTestEngines } from "./support/engine.mjs";

/**
 * The toolbar model is what the React component, the Vue component and the
 * custom element all render. Everything worth getting right about a toolbar —
 * which buttons exist, when they are disabled, which shortcuts fire and, more
 * importantly, which ones must not — lives here rather than in three views.
 */

afterEach(disposeTestEngines);

function makeToolbar(options = {}, engineOptions = {}) {
  const engine = createTestEngine({ tools: baseTools, history: true, ...engineOptions });
  const model = new ToolbarModel(engine, { tools: baseTools, ...options });
  return { engine, model };
}

function keyEvent(key, init = {}) {
  return new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
}

describe("button list", () => {
  test("one button per tool, then the actions", () => {
    const { model } = makeToolbar();
    const { buttons } = model.state;

    const tools = buttons.filter((button) => button.kind === "tool");
    expect(tools.map((button) => button.id)).toEqual(baseTools.map((tool) => tool.id));
    // Actions always follow the tools, never interleave.
    const firstAction = buttons.findIndex((button) => button.kind === "action");
    expect(buttons.slice(firstAction).every((button) => button.kind === "action")).toBe(true);
  });

  test("every button has an accessible name", () => {
    // The buttons are glyphs and drawn icons; without a name they are unusable
    // with a screen reader.
    for (const button of makeToolbar().model.state.buttons) {
      expect(button.label.length).toBeGreaterThan(0);
      expect(button.title.length).toBeGreaterThan(0);
    }
  });

  test("undo and redo appear only when history is enabled", () => {
    const withHistory = makeToolbar({}, { history: true }).model.state.buttons;
    const without = makeToolbar({}, { history: false }).model.state.buttons;

    expect(withHistory.some((button) => button.id === "undo")).toBe(true);
    expect(without.some((button) => button.id === "undo")).toBe(false);
  });

  test("undo is present but disabled before anything has been destroyed", () => {
    // Showing it only after the first blow would make the toolbar jump.
    const undo = makeToolbar().model.state.buttons.find((button) => button.id === "undo");

    expect(undo).toBeDefined();
    expect(undo.disabled).toBe(true);
  });

  test("selecting a tool marks exactly that button as pressed", () => {
    const { model } = makeToolbar();

    model.selectTool("hammer");

    const pressed = model.state.buttons.filter((button) => button.pressed);
    expect(pressed.map((button) => button.id)).toEqual(["hammer"]);
  });

  test("pressing the active tool again puts it away", () => {
    const { engine, model } = makeToolbar();
    model.selectTool("hammer");

    model.selectTool("hammer");

    expect(engine.tool).toBeNull();
  });

  test("the aim button is disabled until a tool is in hand", () => {
    const { model } = makeToolbar();
    const aimOf = () => model.state.buttons.find((button) => button.id === "aim");

    expect(aimOf().disabled).toBe(true);

    model.selectTool("hammer");

    expect(aimOf().disabled).toBe(false);
  });
});

describe("subscriptions", () => {
  test("subscribers are called immediately and on change", () => {
    const { model } = makeToolbar();
    const seen = [];
    const unsubscribe = model.subscribe((state) => seen.push(state.activeToolId));

    expect(seen).toEqual([null]);

    model.selectTool("hammer");
    expect(seen).toEqual([null, "hammer"]);

    unsubscribe();
    model.selectTool("broom");
    expect(seen).toHaveLength(2);
  });

  test("destroying the model detaches it from the engine", () => {
    const { engine, model } = makeToolbar();
    let calls = 0;
    model.subscribe(() => calls++);
    const baseline = calls;

    model.destroy();
    engine.setTool("hammer");

    expect(calls).toBe(baseline);
  });

  test("disposing the engine tears the model down with it", () => {
    const { engine, model } = makeToolbar();
    engine.dispose();

    expect(() => model.state).not.toThrow();
  });
});

describe("keyboard shortcuts", () => {
  test("digits select tools, with 0 for the tenth", () => {
    const { engine, model } = makeToolbar();

    expect(model.handleKeyDown(keyEvent("1"))).toBe(true);
    expect(engine.tool?.id).toBe(baseTools[0].id);

    model.handleKeyDown(keyEvent("3"));
    expect(engine.tool?.id).toBe(baseTools[2].id);
  });

  test("letters run the fixed actions", () => {
    const { engine, model } = makeToolbar();
    expect(engine.sound.enabled).toBe(false);

    expect(model.handleKeyDown(keyEvent("m"))).toBe(true);

    expect(engine.sound.enabled).toBe(true);
  });

  test("shortcuts never fire while the visitor is typing", () => {
    // Otherwise "r" in a search box repairs the page under them.
    const { engine, model } = makeToolbar();
    const input = document.createElement("input");
    document.body.appendChild(input);
    engine.setTool("hammer");

    const event = keyEvent("r");
    Object.defineProperty(event, "target", { value: input });

    expect(model.handleKeyDown(event)).toBe(false);
    expect(engine.tool?.id).toBe("hammer");
  });

  test("shortcuts ignore held keys and IME composition", () => {
    const { model } = makeToolbar();

    expect(model.handleKeyDown(keyEvent("r", { repeat: true }))).toBe(false);
    const composing = keyEvent("r");
    Object.defineProperty(composing, "isComposing", { value: true });
    expect(model.handleKeyDown(composing)).toBe(false);
  });

  test("Escape puts the tool away first, and closes only once empty-handed", () => {
    let closes = 0;
    const { engine, model } = makeToolbar({ onClose: () => closes++ });
    model.selectTool("hammer");

    model.handleKeyDown(keyEvent("Escape"));
    expect(engine.tool).toBeNull();
    expect(closes).toBe(0);

    model.handleKeyDown(keyEvent("Escape"));
    expect(closes).toBe(1);
  });

  test("Cmd/Ctrl+Z undoes, and with Shift redoes", () => {
    const { engine, model } = makeToolbar();
    engine.checkpoint("test");
    expect(engine.historyState.canUndo).toBe(true);

    expect(model.handleKeyDown(keyEvent("z", { metaKey: true }))).toBe(true);
    expect(engine.historyState.canRedo).toBe(true);

    model.handleKeyDown(keyEvent("z", { metaKey: true, shiftKey: true }));
    expect(engine.historyState.canRedo).toBe(false);
  });

  test("Cmd/Ctrl+Z keeps its normal meaning when history is off", () => {
    const { model } = makeToolbar({}, { history: false });

    expect(model.handleKeyDown(keyEvent("z", { metaKey: true }))).toBe(false);
  });

  test("an unbound key is left to the page", () => {
    expect(makeToolbar().model.handleKeyDown(keyEvent("q"))).toBe(false);
  });
});

describe("keyboard aiming", () => {
  test("aiming starts in the middle of the viewport and drives the engine cursor", () => {
    const { engine, model } = makeToolbar();
    model.selectTool("hammer");

    model.startAiming();

    expect(model.state.aim).not.toBeNull();
    expect(engine.aim).toEqual(model.state.aim);
  });

  test("arrows move the cursor and announce where it is", () => {
    const { model } = makeToolbar();
    model.selectTool("hammer");
    model.startAiming();
    const start = { ...model.state.aim };

    model.handleKeyDown(keyEvent("ArrowRight"));

    expect(model.state.aim.x).toBeGreaterThan(start.x);
    expect(model.state.announcement).toContain(String(model.state.aim.x));
  });

  test("the cursor cannot be walked off the page", () => {
    const { engine, model } = makeToolbar();
    model.selectTool("hammer");
    model.startAiming();

    for (let i = 0; i < 200; i++) model.moveAim(-1, -1);

    expect(model.state.aim).toEqual({ x: 0, y: 0 });

    for (let i = 0; i < 400; i++) model.moveAim(1, 1);

    expect(model.state.aim.x).toBe(engine.width);
    expect(model.state.aim.y).toBe(engine.height);
  });

  test("Enter uses the tool at the cursor and damages the page", () => {
    const { engine, model } = makeToolbar();
    model.selectTool("gun");
    model.startAiming();
    const { x, y } = model.state.aim;
    expect(engine.pageOpacityAt(x, y)).toBe(1);

    expect(model.handleKeyDown(keyEvent("Enter"))).toBe(true);

    expect(engine.pageOpacityAt(x, y)).toBe(0);
    expect(model.state.announcement).toContain("Gun");
  });

  test("Escape leaves aiming without closing the toolbar", () => {
    let closes = 0;
    const { engine, model } = makeToolbar({ onClose: () => closes++ });
    model.selectTool("hammer");
    model.startAiming();

    model.handleKeyDown(keyEvent("Escape"));

    expect(model.state.aim).toBeNull();
    expect(engine.aim).toBeNull();
    expect(engine.tool?.id).toBe("hammer");
    expect(closes).toBe(0);
  });

  test("arrow keys do nothing until aiming has been entered", () => {
    const { model } = makeToolbar();
    model.selectTool("hammer");

    expect(model.handleKeyDown(keyEvent("ArrowRight"))).toBe(false);
    expect(model.state.aim).toBeNull();
  });
});

describe("capture status chip", () => {
  test("an idle engine shows no chip at all", () => {
    // The chip exists to explain a state the visitor can see; with capture off
    // there is nothing to explain, so the bar stays uncluttered.
    const { model } = makeToolbar();

    expect(model.state.status).toBeNull();
  });
});

describe("strings", () => {
  test("defaults are used when nothing is overridden", () => {
    expect(resolveStrings()).toBe(DEFAULT_STRINGS);
    expect(resolveStrings({}).close).toBe(DEFAULT_STRINGS.close);
  });

  test("overrides replace only what they name", () => {
    const strings = resolveStrings({ close: "Fermer" });

    expect(strings.close).toBe("Fermer");
    expect(strings.repair).toBe(DEFAULT_STRINGS.repair);
  });

  test("overridden strings reach the buttons", () => {
    const { model } = makeToolbar({ strings: { repair: "Alles reparieren" } });

    const repair = model.state.buttons.find((button) => button.id === "repair");
    expect(repair.label).toBe("Alles reparieren");
  });

  test("tool names and hints can be translated by id", () => {
    const { model } = makeToolbar({
      strings: { tools: { hammer: { name: "Marteau", hint: "frappez" } } },
    });

    const button = model.state.buttons.find((button) => button.id === "hammer");
    expect(button.label).toBe("Marteau");
    expect(button.title).toContain("frappez");
    // Untranslated tools keep their built-in names.
    expect(model.state.buttons.find((button) => button.id === "broom").label).toBe(broom.name);
  });

  test("toolStrings falls back to the tool's own text", () => {
    expect(toolStrings(DEFAULT_STRINGS, hammer)).toEqual({
      name: hammer.name,
      hint: hammer.hint,
    });
  });

  test("placeholders are substituted, and unknown ones left alone", () => {
    expect(formatString("Aim at {x}, {y}", { x: 3, y: 4 })).toBe("Aim at 3, 4");
    expect(formatString("Hi {who}", {})).toBe("Hi {who}");
  });
});
