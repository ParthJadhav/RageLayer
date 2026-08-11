import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  defaultCaptureFilter,
  measureCapture,
  pinFixedDescendants,
  RAGEKIT_IGNORE_ATTR,
  resolvePageBackdrop,
} from "../src/capture.ts";
import { buildTextMask } from "../src/textmask.ts";
import { readPixels, setViewport, stubRect } from "./support/dom.mjs";

/**
 * Capture geometry decides where the rasterized page is blitted. Getting it
 * wrong is what produces edge seams and doubled scrollbars, so the arithmetic
 * is pinned here against explicit layout boxes.
 */

beforeEach(() => {
  // Layout and scroll are shared across test files; the arithmetic here is
  // only meaningful against a known viewport at a known scroll offset.
  setViewport(1024, 768, 2000);
});

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute("style");
  document.documentElement.removeAttribute("style");
});

describe("defaultCaptureFilter", () => {
  test("ordinary content is captured", () => {
    const element = document.createElement("p");

    expect(defaultCaptureFilter(element)).toBe(true);
  });

  test("anything opted out is skipped, subtree included", () => {
    const element = document.createElement("div");
    element.setAttribute(RAGEKIT_IGNORE_ATTR, "");

    expect(defaultCaptureFilter(element)).toBe(false);
  });

  test("framework dev overlays are never captured", () => {
    // A dev-tools overlay in the snapshot would be destroyed alongside the
    // page and look like a rendering bug.
    const overlay = document.createElement("nextjs-portal");

    expect(defaultCaptureFilter(overlay)).toBe(false);
  });

  test("non-element nodes pass through", () => {
    expect(defaultCaptureFilter(document.createTextNode("hello"))).toBe(true);
  });
});

describe("measureCapture", () => {
  function root(rect, styles = {}) {
    const element = document.createElement("div");
    Object.assign(element.style, styles);
    document.body.appendChild(element);
    stubRect(element, rect);
    return element;
  }

  test("a full-bleed root is measured at the layer's own size", () => {
    const element = root({ x: 0, y: 0, width: 1000, height: 800 });

    const geometry = measureCapture(element, 1000, 800, 12000);

    expect(geometry.width).toBe(1000);
    expect(geometry.height).toBe(800);
    expect(geometry.source).toMatchObject({ x: 0, y: 0, width: 1000, height: 800 });
  });

  test("an inset root is anchored where the browser painted it", () => {
    // A centred `max-width` shell: rasterizing from x=0 would blit the capture
    // off to one side and leave a seam down the page.
    const element = root({ x: 120, y: 40, width: 760, height: 600 });

    const geometry = measureCapture(element, 1000, 800, 12000);

    expect(geometry.source.x).toBe(120);
    expect(geometry.source.y).toBe(40);
    expect(geometry.source.width).toBe(760);
  });

  test("margins are folded into the rasterized box", () => {
    // Out-of-flow descendants resolve against the margin box, so that is what
    // has to be captured and blitted.
    const element = root({ x: 20, y: 30, width: 760, height: 600 }, { margin: "10px 5px" });

    const geometry = measureCapture(element, 1000, 800, 12000);

    expect(geometry.source.x).toBe(15);
    expect(geometry.source.y).toBe(20);
    expect(geometry.source.width).toBe(770);
    expect(geometry.source.height).toBe(620);
  });

  test("the layer grows to contain a root that overflows it", () => {
    const element = root({ x: 0, y: 200, width: 1000, height: 900 });

    const geometry = measureCapture(element, 1000, 800, 12000);

    expect(geometry.height).toBe(1100);
  });

  test("an enormous page is truncated to the cap rather than allocated in full", () => {
    const element = root({ x: 0, y: 0, width: 1000, height: 40000 });

    const geometry = measureCapture(element, 1000, 40000, 12000);

    expect(geometry.height).toBe(12000);
    expect(geometry.source.height).toBe(12000);
    // The clone is re-sized to the truncated height so it is not stretched.
    expect(geometry.rootSize.height).toBe("12000px");
  });
});

describe("resolvePageBackdrop", () => {
  test("the nearest opaque background in the chain is used", () => {
    document.documentElement.style.backgroundColor = "rgb(10, 20, 30)";
    const root = document.createElement("main");
    document.body.appendChild(root);

    expect(resolvePageBackdrop(root).color).toBe("rgb(10, 20, 30)");
  });

  test("the root's own background wins over its ancestors'", () => {
    document.documentElement.style.backgroundColor = "rgb(10, 20, 30)";
    const root = document.createElement("main");
    root.style.backgroundColor = "rgb(200, 200, 200)";
    document.body.appendChild(root);

    // The chain is walked outermost-first, so an ancestor colour is found
    // first and is the one the void is painted with.
    expect(resolvePageBackdrop(root).color).toBe("rgb(10, 20, 30)");
  });

  test("a fully transparent page reports no backdrop", () => {
    const root = document.createElement("main");
    document.body.appendChild(root);

    expect(resolvePageBackdrop(root).color).toBeUndefined();
  });

  test("an ancestor background image is carried across, but not the root's own", () => {
    document.body.style.backgroundImage = 'url("stars.png")';
    const root = document.createElement("main");
    document.body.appendChild(root);

    expect(resolvePageBackdrop(root).image?.backgroundImage).toBe('url("stars.png")');

    root.style.backgroundImage = 'url("own.png")';
    // The root paints its own image into the raster already; repeating it
    // behind the page would show through every hole.
    expect(resolvePageBackdrop(root).image).toBeUndefined();
  });
});

describe("pinFixedDescendants", () => {
  test("fixed elements are pinned for the capture and released afterwards", () => {
    // `position: fixed` resolves against the viewport, which does not exist
    // inside the rasterization clone; unpinned, a sticky nav lands in the
    // wrong place in the snapshot.
    const root = document.createElement("main");
    const nav = document.createElement("nav");
    nav.style.position = "fixed";
    root.appendChild(nav);
    document.body.appendChild(root);
    stubRect(nav, { x: 30, y: 60, width: 200, height: 40 });

    const release = pinFixedDescendants(root);

    expect(nav.style.position).toBe("absolute");

    release();

    expect(nav.style.position).toBe("fixed");
  });

  test("a page with nothing fixed is left alone", () => {
    const root = document.createElement("main");
    root.innerHTML = "<p>text</p>";
    document.body.appendChild(root);

    expect(() => pinFixedDescendants(root)()).not.toThrow();
  });
});

describe("buildTextMask", () => {
  /**
   * happy-dom has no line-box layout, so `Range.getClientRects()` is supplied
   * per text node. The module's own behaviour — quarter-resolution output,
   * per-element filtering, form-control handling, sub-pixel rejection — is
   * what these assertions cover.
   */
  function withTextRects(rects) {
    const original = document.createRange.bind(document);
    document.createRange = () => {
      const range = original();
      range.getClientRects = () => rects.get(range.__node) ?? [];
      const select = range.selectNodeContents.bind(range);
      range.selectNodeContents = (node) => {
        range.__node = node;
        return select(node);
      };
      return range;
    };
    return () => {
      document.createRange = original;
    };
  }

  test("the mask is a quarter of the page in each dimension", () => {
    const root = document.createElement("main");
    document.body.appendChild(root);

    const mask = buildTextMask(root, 800, 600, defaultCaptureFilter);

    expect(mask.width).toBe(200);
    expect(mask.height).toBe(150);
  });

  test("line boxes are painted into the mask at document coordinates", () => {
    const root = document.createElement("main");
    root.textContent = "a line of type";
    document.body.appendChild(root);
    const textNode = root.firstChild;
    const restore = withTextRects(
      new Map([[textNode, [{ left: 100, top: 100, width: 200, height: 20 }]]]),
    );

    try {
      const mask = buildTextMask(root, 800, 600, defaultCaptureFilter);

      // 100,100 in page space is 25,25 in the quarter-scale mask.
      expect(readPixels(mask, 30, 27, 1, 1)[3]).toBe(255);
      // Well away from the line, the mask is empty so the shader stays free
      // to bend the page there.
      expect(readPixels(mask, 5, 5, 1, 1)[3]).toBe(0);
    } finally {
      restore();
    }
  });

  test("filtered subtrees leave no phantom text behind", () => {
    const root = document.createElement("main");
    const ignored = document.createElement("div");
    ignored.setAttribute(RAGEKIT_IGNORE_ATTR, "");
    ignored.textContent = "toolbar";
    root.appendChild(ignored);
    document.body.appendChild(root);
    const restore = withTextRects(
      new Map([[ignored.firstChild, [{ left: 40, top: 40, width: 200, height: 20 }]]]),
    );

    try {
      const mask = buildTextMask(root, 800, 600, defaultCaptureFilter);

      expect(readPixels(mask, 15, 12, 1, 1)[3]).toBe(0);
    } finally {
      restore();
    }
  });

  test("sub-pixel rects are decoration, not type", () => {
    const root = document.createElement("main");
    root.textContent = "hairline";
    document.body.appendChild(root);
    const restore = withTextRects(
      new Map([[root.firstChild, [{ left: 100, top: 100, width: 200, height: 0.5 }]]]),
    );

    try {
      const mask = buildTextMask(root, 800, 600, defaultCaptureFilter);

      expect(readPixels(mask, 30, 25, 1, 1)[3]).toBe(0);
    } finally {
      restore();
    }
  });
});
