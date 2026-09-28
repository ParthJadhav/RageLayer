import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RageLayer } from "../src/react/RageLayer.tsx";
import { useRageLayer } from "../src/react/useRageLayer.ts";
import { broom, hammer } from "../src/tools.ts";
import { setViewport } from "./support/dom.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;

function buttons() {
  return [...document.querySelectorAll('[role="toolbar"] button')];
}

function buttonNamed(label) {
  return buttons().find((button) => button.getAttribute("aria-label") === label);
}

async function mount(props = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(RageLayer, {
        tools: [hammer],
        engineOptions: { captureContent: false },
        ...props,
      }),
    );
  });
}

beforeEach(() => setViewport(1024, 768, 2000));

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  document.body.replaceChildren();
});

describe("shared toolbar state", () => {
  test("renders translated labels and a visible tool instruction", async () => {
    await mount({ strings: { toolbarLabel: "Outils de destruction" } });

    expect(document.querySelector('[role="toolbar"]').getAttribute("aria-label")).toBe(
      "Outils de destruction",
    );
    expect(document.querySelector(".rl-hint-pill").textContent).toContain(hammer.name);
    expect(document.querySelector(".rl-hint-pill").textContent).toContain(hammer.hint);
  });

  test("touching a tool updates the persistent instruction", async () => {
    await mount({ tools: [hammer, broom] });

    await act(async () => {
      buttonNamed(broom.name).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });

    expect(document.querySelector(".rl-hint-pill").textContent).toContain(broom.name);
    expect(document.querySelector(".rl-hint-pill").textContent).toContain(broom.hint);
  });

  test("unmounting disposes the engine and removes the portal", async () => {
    await mount({ debugGlobal: true });
    const engine = window.__rageLayer;

    await act(async () => root.unmount());
    root = undefined;

    expect(engine.disposed).toBe(true);
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    expect(window.__rageLayer).toBeUndefined();
  });
});

test("the headless hook survives StrictMode and rerenders, then disposes on unmount", async () => {
  let session;
  function Controls({ options }) {
    session = useRageLayer(options);
    return null;
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = () =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(Controls, { options: { captureContent: false, tools: [hammer] } }),
      ),
    );
  await act(async () => render());
  expect(session.isOpen).toBe(false);
  expect(session.engine).toBeNull();
  const open = session.open;
  let engine;
  await act(async () => {
    engine = session.open();
  });
  expect(session.engine).toBe(engine);
  expect(session.isOpen).toBe(true);
  await act(async () => render());
  expect(session.open).toBe(open);
  expect(session.engine).toBe(engine);
  expect(session.open()).toBe(engine);
  await act(async () => session.close());
  expect(session.isOpen).toBe(false);
  expect(engine.disposed).toBe(true);
  await act(async () => {
    engine = session.toggle();
  });
  expect(session.isOpen).toBe(true);
  await act(async () => root.unmount());
  root = undefined;
  expect(engine.disposed).toBe(true);
});
