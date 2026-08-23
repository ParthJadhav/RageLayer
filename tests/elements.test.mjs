import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultCaptureFilter } from "../src/capture.ts";
import { elementAt, elementsInBand, harvestElements } from "../src/elements.ts";
import { setViewport, stubRect } from "./support/dom.mjs";

/**
 * `harvestElements` maps the page's furniture so the demolition tool has real
 * things to knock loose. happy-dom performs no layout, so every element's box
 * is supplied explicitly — the module's own selection rules (size floors,
 * wrapper rejection, innermost-wins, the capture filter) are what is under
 * test, and those are pure logic over those boxes.
 */

let root;

function build(html) {
  root = document.createElement("main");
  root.innerHTML = html;
  document.body.appendChild(root);
  Object.defineProperty(root, "scrollWidth", { configurable: true, value: 1000 });
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: 1000 });
  return root;
}

function place(selector, x, y, w, h) {
  const element = root.querySelector(selector);
  stubRect(element, { x, y, width: w, height: h });
  return element;
}

beforeEach(() => {
  setViewport(1024, 768, 2000);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("harvesting", () => {
  test("cards of a reasonable size become demolition targets", () => {
    build(`<div class="a">Card one</div><div class="b">Card two</div>`);
    place(".a", 0, 0, 200, 120);
    place(".b", 0, 200, 200, 120);

    const harvested = harvestElements(root, defaultCaptureFilter);

    expect(harvested).toHaveLength(2);
    expect(harvested[0]).toMatchObject({ x: 0, y: 0, w: 200, h: 120, taken: false });
  });

  test("slivers and thin rules are too small to be furniture", () => {
    build(`<div class="tiny">x</div><div class="thin">y</div>`);
    place(".tiny", 0, 0, 20, 20); // below the area floor
    place(".thin", 0, 40, 400, 4); // below the side floor

    expect(harvestElements(root, defaultCaptureFilter)).toHaveLength(0);
  });

  test("an element that is the page is not furniture on it", () => {
    build(`<div class="hero">Everything</div>`);
    place(".hero", 0, 0, 990, 990);

    expect(harvestElements(root, defaultCaptureFilter)).toHaveLength(0);
  });

  test("the innermost candidate wins over its wrapper", () => {
    build(`<section class="wrap"><p class="inner">Body copy</p></section>`);
    place(".wrap", 0, 0, 300, 200);
    place(".inner", 10, 10, 280, 180);

    const harvested = harvestElements(root, defaultCaptureFilter);

    // The section adds no granularity over the paragraph that fills it.
    expect(harvested).toHaveLength(1);
    expect(harvested[0].w).toBe(280);
  });

  test("empty containers with nothing visible inside are skipped", () => {
    build(`<div class="empty"></div>`);
    place(".empty", 0, 0, 200, 200);

    expect(harvestElements(root, defaultCaptureFilter)).toHaveLength(0);
  });

  test("replaced elements qualify on area alone", () => {
    build(`<img class="pic" alt="" />`);
    place(".pic", 0, 0, 60, 60);

    const harvested = harvestElements(root, defaultCaptureFilter);

    expect(harvested).toHaveLength(1);
    // Images are solid: they fracture rather than shearing off like bare text.
    expect(harvested[0].solid).toBe(true);
  });

  test("script and style nodes are never targets", () => {
    build(`<script class="s">let x</script><div class="d">Real</div>`);
    place(".s", 0, 0, 300, 300);
    place(".d", 0, 400, 200, 120);

    const harvested = harvestElements(root, defaultCaptureFilter);

    expect(harvested).toHaveLength(1);
    expect(harvested[0].y).toBe(400);
  });

  test("RageLayer's own furniture is filtered out", () => {
    // The toolbar is marked `data-ragelayer-ignore`; making it demolishable would let
    // the toy destroy its own controls.
    build(
      `<div class="ui" data-ragelayer-ignore><span>Tools</span></div><div class="d">Real</div>`,
    );
    place(".ui", 0, 0, 200, 120);
    place(".d", 0, 200, 200, 120);

    const harvested = harvestElements(root, defaultCaptureFilter);

    expect(harvested).toHaveLength(1);
    expect(harvested[0].y).toBe(200);
  });
});

describe("elementAt", () => {
  const list = [
    { x: 0, y: 0, w: 300, h: 300, solid: true, taken: false },
    { x: 50, y: 50, w: 100, h: 100, solid: false, taken: false },
  ];

  test("the smallest element containing the point wins", () => {
    // Overlapping targets should resolve to the thing visibly under the cursor.
    expect(elementAt(list, 100, 100)).toBe(list[1]);
  });

  test("elements already knocked loose are skipped", () => {
    const taken = [{ ...list[1], taken: true }, list[0]];

    expect(elementAt(taken, 100, 100)).toBe(taken[1]);
  });

  test("a near miss resolves through slack, but containment still wins", () => {
    const thin = [{ x: 100, y: 100, w: 200, h: 26, solid: false, taken: false }];

    // A click in the leading just below a line of body copy: exact hit
    // testing makes the demolition tool feel broken there.
    expect(elementAt(thin, 150, 134)).toBeNull();
    expect(elementAt(thin, 150, 134, 12)).toBe(thin[0]);
    // A genuine containment still takes priority over anything reached by slack.
    expect(elementAt(list, 100, 100, 40)).toBe(list[1]);
  });

  test("a click in open space finds nothing", () => {
    expect(elementAt(list, 900, 900, 10)).toBeNull();
  });
});

describe("elementsInBand", () => {
  const list = [
    { x: 0, y: 0, w: 100, h: 50, solid: true, taken: false },
    { x: 0, y: 100, w: 100, h: 50, solid: true, taken: false },
    { x: 0, y: 400, w: 100, h: 50, solid: true, taken: false },
    { x: 0, y: 120, w: 100, h: 50, solid: true, taken: true },
  ];

  test("only untaken elements intersecting the band are returned", () => {
    const band = elementsInBand(list, 80, 200, 200);

    // y=0 ends above the band, y=400 starts below it, and y=120 is already
    // knocked loose — a collapsing page must not take the same piece twice.
    expect(band.map((el) => el.y)).toEqual([100]);
  });

  test("results are ordered by distance from the front", () => {
    const band = elementsInBand(list, 0, 500, 110);

    expect(band[0].y).toBe(100);
  });
});
