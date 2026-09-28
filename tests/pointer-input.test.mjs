import { afterEach, describe, expect, test } from "bun:test";
import { createPointerInput } from "../src/pointer-input";
import { pointerEvent } from "./support/dom.mjs";

const controllers = new Set();

afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.clear();
  document.body.replaceChildren();
});

function makeInput(tool, overrides = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let blocked = false;
  let now = 1;
  const host = {
    engine: {},
    container,
    getTool: () => tool,
    isBlocked: () => blocked,
    coordinates: () => ({ scrollX: 0, scrollY: 0, originX: 0, originY: 0 }),
    nowSeconds: () => now,
    checkpoint: () => {},
    requestFrame: () => {},
    silenceToolLoops: () => {},
    ...overrides,
  };
  const input = createPointerInput(host);
  controllers.add(input);
  return {
    container,
    input,
    setBlocked(value) {
      blocked = value;
    },
    setNow(value) {
      now = value;
    },
  };
}

describe("PointerInputController", () => {
  test("a throwing release handler still releases pointer capture and silences audio", () => {
    let silenced = 0;
    let released = 0;
    const { container, input } = makeInput(
      {
        onUp: () => {
          throw new Error("release failed");
        },
      },
      {
        silenceToolLoops: () => silenced++,
      },
    );
    container.releasePointerCapture = () => released++;
    container.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    expect(() => input.end()).toThrow("release failed");
    expect(input.held).toBe(false);
    expect(silenced).toBe(1);
    expect(released).toBe(1);
  });
  test("scripted strikes reject invalid coordinates and overlapping gestures", () => {
    let downs = 0;
    const { input, container } = makeInput({ onDown: () => downs++ });
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(input.strike(value, 10)).toBe(false);
      expect(input.strike(10, value)).toBe(false);
      expect(input.strike(10, 10, value)).toBe(false);
    }
    expect(downs).toBe(0);
    container.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    expect(input.strike(20, 20)).toBe(false);
    expect(input.held).toBe(true);
    expect(downs).toBe(1);
  });

  test("a throwing scripted tool releases gesture state and audio loops", () => {
    let silenced = 0;
    const { input } = makeInput(
      {
        onDown: () => {
          throw new Error("tool failed");
        },
      },
      {
        silenceToolLoops: () => silenced++,
      },
    );
    expect(() => input.strike(10, 10)).toThrow("tool failed");
    expect(input.held).toBe(false);
    expect(silenced).toBe(1);
  });
  test("buffers a path in order and bounds an event storm", () => {
    const moves = [];
    const { container, input } = makeInput({
      id: "probe",
      name: "Probe",
      icon: "p",
      hint: "move",
      onMove: (_engine, event) => moves.push({ ...event }),
    });

    for (let x = 0; x < 40; x++) {
      container.dispatchEvent(pointerEvent("pointermove", x, 10));
    }
    input.flush();

    expect(moves).toHaveLength(32);
    expect(moves[0]).toMatchObject({ x: 0, y: 10, dx: 0, dy: 0 });
    expect(moves.at(-1).x).toBe(39);
    expect(moves.reduce((total, move) => total + move.dx, 0)).toBe(39);
  });

  test("an administrative cancel discards movement queued before undo", () => {
    let moves = 0;
    let ups = 0;
    const { container, input } = makeInput({
      id: "probe",
      name: "Probe",
      icon: "p",
      hint: "drag",
      onMove: () => moves++,
      onUp: () => ups++,
    });

    container.dispatchEvent(pointerEvent("pointerdown", 10, 10));
    expect(input.pointer).toEqual({ x: 10, y: 10 });
    container.dispatchEvent(pointerEvent("pointermove", 20, 20));
    input.cancel();
    input.flush();

    expect(input.held).toBe(false);
    expect(moves).toBe(0);
    expect(ups).toBe(0);
  });

  test("scripted strikes share gesture state and a deterministic 60 Hz hold", () => {
    const events = [];
    const held = [];
    const { input, setNow } = makeInput({
      id: "probe",
      name: "Probe",
      icon: "p",
      hint: "hold",
      onDown: (_engine, event) => events.push(["down", event.buttons]),
      tick: (_engine, _dt, isHeld) => held.push(isHeld),
      onUp: (_engine, event) => events.push(["up", event.buttons]),
    });
    setNow(4);

    expect(input.strike(30, 40, 50)).toBe(true);

    expect(events).toEqual([
      ["down", 1],
      ["up", 0],
    ]);
    expect(held).toEqual([true, true, true]);
    expect(input.pointer).toEqual({ x: 30, y: 40 });
    expect(input.artDownAt).toBe(4);
    expect(input.artUpAt).toBe(4);
  });
});
