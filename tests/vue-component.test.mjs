import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hammer } from "../src/tools.ts";
import { setViewport } from "./support/dom.mjs";

// Mounted after the DOM harness for the same reason the custom element is:
// these modules read browser globals while they evaluate.
const { createApp, h, nextTick } = await import("vue");
const { RageLayer } = await import("../src/vue/RageLayer.ts");

/**
 * Vue previously got a headless composable and a note to build the toolbar
 * itself. These tests hold the ready-made component to the same contract as
 * the React one: a labelled, keyboard-operable toolbar that disposes its
 * engine when the component unmounts.
 */

let app;
let host;

/**
 * The component renders nothing until it is mounted in a browser (its SSR
 * guard), and Vue applies that state change on the next tick — so every test
 * has to await one before the toolbar exists.
 */
async function mount(props = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  app = createApp({ render: () => h(RageLayer, props) });
  app.mount(host);
  await nextTick();
  return app;
}

function bar() {
  return document.querySelector('[role="toolbar"]');
}

function buttons() {
  return [...(bar()?.querySelectorAll("button") ?? [])];
}

beforeEach(() => setViewport(1024, 768, 2000));

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
  document.body.replaceChildren();
});

describe("rendering", () => {
  test("a labelled toolbar is teleported into the body", async () => {
    await mount({ tools: [hammer], engineOptions: { captureContent: false } });

    expect(bar()).not.toBeNull();
    expect(bar().getAttribute("aria-label")).toBe("RageLayer tools");
    expect(buttons().length).toBeGreaterThan(1);
  });

  test("the toolbar is excluded from the page it destroys", async () => {
    await mount({ tools: [hammer], engineOptions: { captureContent: false } });

    expect(document.querySelector("[data-ragelayer-ignore]")).not.toBeNull();
  });

  test("every button has an accessible name and exactly one is tabbable", async () => {
    await mount({ tools: [hammer], engineOptions: { captureContent: false } });

    for (const button of buttons()) {
      expect(button.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
    }
    expect(buttons().filter((button) => button.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  test("a live region is present for keyboard aiming announcements", async () => {
    await mount({ tools: [hammer], engineOptions: { captureContent: false } });

    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  test("overridden strings reach the buttons", async () => {
    await mount({
      tools: [hammer],
      engineOptions: { captureContent: false },
      strings: { toolbarLabel: "Outils", close: "Fermer" },
    });

    expect(bar().getAttribute("aria-label")).toBe("Outils");
    expect(buttons().some((button) => button.getAttribute("aria-label") === "Fermer")).toBe(true);
  });
});

describe("interaction", () => {
  test("clicking a tool selects it on the engine", async () => {
    let engine;
    await mount({
      tools: [hammer],
      engineOptions: { captureContent: false },
      onReady: (created) => {
        engine = created;
      },
    });

    buttons()
      .find((button) => button.getAttribute("aria-label") === hammer.name)
      .click();

    expect(engine.tool?.id).toBe("hammer");
  });

  test("closing emits the close event", async () => {
    let closes = 0;
    await mount({
      tools: [hammer],
      engineOptions: { captureContent: false },
      onClose: () => closes++,
    });

    buttons()
      .find((button) => button.getAttribute("aria-label") === "Close RageLayer")
      .click();

    expect(closes).toBe(1);
  });
});

describe("lifecycle", () => {
  test("unmounting disposes the engine and removes the toolbar", async () => {
    let engine;
    await mount({
      tools: [hammer],
      engineOptions: { captureContent: false },
      onReady: (created) => {
        engine = created;
      },
    });
    expect(engine.disposed).toBe(false);

    app.unmount();
    app = undefined;

    expect(engine.disposed).toBe(true);
    expect(bar()).toBeNull();
    expect(document.body.contains(engine.container)).toBe(false);
  });
});
