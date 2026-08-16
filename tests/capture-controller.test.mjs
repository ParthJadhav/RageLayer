import { afterEach, describe, expect, test } from "bun:test";
import { CaptureController } from "../src/capture-controller.ts";
import { ContentLayer } from "../src/content.ts";
import { Overlay } from "../src/overlay.ts";
import { makeCanvas, setViewport } from "./support/dom.mjs";

/**
 * The controller's job is to be the thing that never breaks the toy: whichever
 * way rasterization fails, RageLayer has to keep working in overlay mode
 * and say so. These drive it directly, without an engine around it.
 *
 * The rasterizers themselves are browser-only — html-to-image needs a real SVG
 * image decode, `drawElementImage` needs Chrome behind a flag — so what is
 * asserted here is the surrounding decision-making: status reporting, fallback,
 * content-mode entry and exit, and the reflow guard.
 */

const WIDTH = 400;
const HEIGHT = 600;

const overlays = [];

function makeOverlay() {
  const overlay = new Overlay({ zIndex: 1, reducedMotion: true, desynchronizedFx: true });
  overlay.mount(document.body);
  overlay.resize(WIDTH, HEIGHT, 1);
  overlays.push(overlay);
  return overlay;
}

/** A controller plus a record of everything it told its host. */
function makeController(settings = {}) {
  setViewport(WIDTH, Math.min(HEIGHT, 768), HEIGHT);
  const overlay = makeOverlay();
  const events = { statuses: [], errors: [], elements: [], landed: 0, settled: [] };
  const host = {
    overlay,
    docSize: () => ({ width: WIDTH, height: HEIGHT }),
    refreshBand: () => ({ y0: 0, y1: HEIGHT }),
    onElements: (elements) => events.elements.push(elements),
    onStatusChange: () => events.statuses.push(controller.captureStatus),
    onError: (scope, message, cause) => events.errors.push({ scope, message, cause }),
    onCaptureLanded: () => {
      events.landed++;
    },
    onCaptureSettled: (ms) => events.settled.push(ms),
  };
  const controller = new CaptureController(host, {
    root: document.body,
    mode: "snapshot",
    liveRefreshMs: 0,
    harvestElements: false,
    physics: true,
    textMask: false,
    filter: () => true,
    surface: undefined,
    ...settings,
  });
  return { controller, host, overlay, events };
}

function makeLayer() {
  const layer = new ContentLayer();
  layer.adopt(makeCanvas(WIDTH, HEIGHT, "#3d6fb5"), WIDTH, HEIGHT);
  return layer;
}

afterEach(() => {
  for (const overlay of overlays) overlay.dispose();
  overlays.length = 0;
  document.body.replaceChildren();
  document.body.style.visibility = "";
});

describe("CaptureController", () => {
  test("starts idle with no content", () => {
    const { controller } = makeController();
    expect(controller.captureStatus).toBe("idle");
    expect(controller.content).toBeNull();
    expect(controller.liveUnavailable).toBe(false);
  });

  test("records up front that live was asked for and is unavailable", () => {
    // happy-dom has no `drawElementImage`, which is the case this reports: the
    // toolbar needs to say *why* it ended up in snapshot mode.
    const { controller } = makeController({ mode: "live" });
    expect(controller.liveUnavailable).toBe(true);
  });

  test("an installed layer becomes the content and sits under the damage canvas", () => {
    const { controller, overlay } = makeController();
    const layer = makeLayer();
    controller.install(layer);

    expect(controller.content).toBe(layer);
    const children = [...overlay.container.children];
    expect(children.indexOf(layer.canvas)).toBeLessThan(children.indexOf(overlay.damageCanvas));
    layer.dispose();
  });

  test("installing null clears the content", () => {
    const { controller } = makeController();
    const layer = makeLayer();
    controller.install(layer);
    controller.install(null);
    expect(controller.content).toBeNull();
    layer.dispose();
  });

  test("a layer that never captured is not content", () => {
    const { controller } = makeController();
    // `ready` only goes true once a raster has been adopted.
    controller.install(new ContentLayer());
    expect(controller.content).toBeNull();
  });

  test("a failed capture falls back to overlay mode and reports it", async () => {
    const { controller, events } = makeController();
    // No rasterizer here, so this exercises the failure path the toy is built
    // to survive: report, drop the layer, stay usable.
    await controller.capture();

    expect(controller.captureStatus).toBe("idle");
    expect(controller.content).toBeNull();
    expect(events.statuses[0]).toBe("capturing");
    expect(events.errors.map((e) => e.scope)).toContain("capture");
    // Settled fires either way, so the engine can always stop its spinner.
    expect(events.settled).toHaveLength(1);
    expect(events.settled[0]).toBeGreaterThanOrEqual(0);
    expect(events.landed).toBe(0);
  });

  test("concurrent capture calls collapse into one attempt", async () => {
    const { controller, events } = makeController();
    await Promise.all([controller.capture(), controller.capture()]);
    expect(events.settled).toHaveLength(1);
  });

  test("harvesting is skipped when physics is off", async () => {
    const { controller, events } = makeController({ harvestElements: true, physics: false });
    await controller.capture();
    expect(events.elements).toHaveLength(0);
  });

  test("harvesting reports the page's furniture when both flags are on", async () => {
    const heading = document.createElement("h1");
    heading.textContent = "Destroy me";
    document.body.appendChild(heading);
    const { controller, events } = makeController({ harvestElements: true, physics: true });
    await controller.capture();
    // The harvest runs before rasterization, so it happens even though the
    // capture itself goes on to fail in this environment.
    expect(events.elements).toHaveLength(1);
    expect(Array.isArray(events.elements[0])).toBe(true);
  });

  test("entering content mode hides the root, and exiting puts it back", () => {
    document.body.style.visibility = "visible";
    const { controller, overlay } = makeController();
    controller.install(makeLayer());
    // `capture()` is what normally enters content mode; drive the exit path
    // directly, which is what `pagehide` and `dispose` both use.
    controller.exitContentMode();
    expect(overlay.voidLayer.style.display).toBe("none");
    expect(document.body.style.visibility).toBe("visible");
  });

  test("refresh is a no-op outside live mode", async () => {
    const { controller, events } = makeController();
    controller.install(makeLayer());
    await controller.refresh();
    expect(events.errors).toHaveLength(0);
  });

  test("a reflow to the same size does not re-capture", () => {
    const { controller, events } = makeController();
    controller.install(makeLayer());
    controller.recaptureAfterReflow();
    expect(events.statuses).toHaveLength(0);
  });

  test("a reflow to a different size tears the capture down and starts over", () => {
    const { controller, host, events } = makeController();
    controller.install(makeLayer());
    host.docSize = () => ({ width: WIDTH, height: HEIGHT * 2 });
    controller.recaptureAfterReflow();
    expect(events.statuses[0]).toBe("capturing");
  });

  test("dispose stops everything and reports idle", async () => {
    const { controller, events } = makeController();
    controller.install(makeLayer());
    controller.dispose();

    expect(controller.content).toBeNull();
    expect(controller.contentRoot).toBeNull();
    expect(controller.captureStatus).toBe("idle");
    // A capture requested after disposal never starts.
    const before = events.settled.length;
    await controller.capture();
    expect(events.settled).toHaveLength(before);
  });
});
