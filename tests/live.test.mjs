import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { LiveContentSource, mutationTouchesCapture } from "../src/live.ts";
import "./support/dom.mjs";

/**
 * The live rasterizer itself is browser-only — `drawElementImage` exists in
 * Chrome behind a flag — so what is pinned here is the staleness bookkeeping
 * around it: a repaint redraws a *clone*, and the mirror must stop claiming it
 * can repaint the moment the real page changes in a way only a re-clone can
 * show. The draw calls themselves fail harmlessly on happy-dom's canvas, which
 * `paint()` tolerates by design.
 */

const rejectIgnored = (el) => !el.hasAttribute("data-test-ignore");

function makePage() {
  const root = document.body;
  const content = document.createElement("main");
  content.textContent = "hello";
  const toolbar = document.createElement("div");
  toolbar.setAttribute("data-test-ignore", "");
  toolbar.textContent = "0 fps";
  root.append(content, toolbar);
  return { root, content, toolbar };
}

/** MutationObserver callbacks are delivered async; let them land. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("mutationTouchesCapture", () => {
  afterEach(() => document.body.replaceChildren());

  test("a change in kept content touches the capture", () => {
    const { root, content } = makePage();
    expect(mutationTouchesCapture(root, rejectIgnored, { target: content })).toBe(true);
  });

  test("a text-node target walks up to its owning element", () => {
    const { root, content } = makePage();
    expect(mutationTouchesCapture(root, rejectIgnored, { target: content.firstChild })).toBe(true);
  });

  test("a change inside a filtered-out element does not", () => {
    const { root, toolbar } = makePage();
    expect(mutationTouchesCapture(root, rejectIgnored, { target: toolbar })).toBe(false);
    expect(mutationTouchesCapture(root, rejectIgnored, { target: toolbar.firstChild })).toBe(false);
  });

  test("a change on the root itself counts", () => {
    const { root } = makePage();
    expect(mutationTouchesCapture(root, rejectIgnored, { target: root })).toBe(true);
  });

  test("a detached node does not", () => {
    const { root } = makePage();
    const orphan = document.createElement("div");
    expect(mutationTouchesCapture(root, rejectIgnored, { target: orphan })).toBe(false);
  });
});

describe("LiveContentSource staleness", () => {
  // Fake the two Chrome-only feature-detection points so `capture()` runs.
  // happy-dom registers no CanvasRenderingContext2D global, so supply one.
  let madeCtxClass = false;
  beforeAll(() => {
    if (typeof globalThis.CanvasRenderingContext2D === "undefined") {
      globalThis.CanvasRenderingContext2D = class CanvasRenderingContext2D {};
      madeCtxClass = true;
    }
    globalThis.CanvasRenderingContext2D.prototype.drawElementImage = () => new DOMMatrix();
    HTMLCanvasElement.prototype.requestPaint = () => {};
    if (!("onpaint" in HTMLCanvasElement.prototype)) HTMLCanvasElement.prototype.onpaint = null;
  });

  afterAll(() => {
    delete globalThis.CanvasRenderingContext2D.prototype.drawElementImage;
    if (madeCtxClass) delete globalThis.CanvasRenderingContext2D;
    delete HTMLCanvasElement.prototype.requestPaint;
    delete HTMLCanvasElement.prototype.onpaint;
  });

  const sources = [];
  afterEach(() => {
    for (const source of sources) source.dispose();
    sources.length = 0;
    document.body.replaceChildren();
  });

  async function capturedPage() {
    const page = makePage();
    const source = new LiveContentSource();
    sources.push(source);
    await source.capture(page.root, 400, 600, 1, {
      source: { x: 0, y: 0, width: 400, height: 600 },
      filter: rejectIgnored,
    });
    await flush();
    return { ...page, source };
  }

  test("a fresh capture can repaint", async () => {
    const { source } = await capturedPage();
    expect(source.canRepaint).toBe(true);
  });

  test("a mutation inside a filtered-out element leaves the mirror repaintable", async () => {
    const { source, toolbar } = await capturedPage();
    toolbar.textContent = "60 fps";
    await flush();
    expect(source.canRepaint).toBe(true);
  });

  test("a content mutation forces the next refresh to re-clone", async () => {
    const { source, content } = await capturedPage();
    content.textContent = "changed";
    await flush();
    expect(source.canRepaint).toBe(false);
    expect(source.repaint()).toBeNull();
  });

  test("an element inserted after capture forces a re-clone", async () => {
    const { source, root } = await capturedPage();
    root.prepend(document.createElement("aside"));
    await flush();
    expect(source.canRepaint).toBe(false);
  });

  test("re-capturing re-arms the watch", async () => {
    const { source, root, content } = await capturedPage();
    content.textContent = "changed";
    await flush();
    expect(source.canRepaint).toBe(false);

    await source.capture(root, 400, 600, 1, {
      source: { x: 0, y: 0, width: 400, height: 600 },
      filter: rejectIgnored,
    });
    await flush();
    expect(source.canRepaint).toBe(true);

    content.textContent = "changed again";
    await flush();
    expect(source.canRepaint).toBe(false);
  });
});
