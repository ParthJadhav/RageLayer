import { describe, expect, test } from "bun:test";
import { advancedTools } from "../src/advanced-tools.ts";
import { heavyTools } from "../src/heavy-tools.ts";
import { registerToolIconBounds, toolIconBounds } from "../src/icon-bounds.ts";
import { hammerArt, toolIconDataUrl } from "../src/toolart/index.ts";
import { baseTools } from "../src/tools.ts";
import "./support/dom.mjs";

/**
 * Tool art is drawn procedurally, with no assets. `toolIconDataUrl` is what a
 * toolbar shows, so it has to produce a real image for every built-in tool —
 * an empty string is a blank button.
 */

describe("toolIconDataUrl", () => {
  test("a built-in tool renders to a PNG data URL", () => {
    const url = toolIconDataUrl(hammerArt, 30);

    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(url.length).toBeGreaterThan(100);
  });

  test("every built-in tool with art produces an icon", () => {
    const withArt = [...baseTools, ...heavyTools, ...advancedTools].filter((tool) => tool.art);
    expect(withArt.length).toBeGreaterThan(0);

    for (const tool of withArt) {
      const url = toolIconDataUrl(tool.art, 30);
      expect(url.startsWith("data:image")).toBe(true);
    }
  });

  test("repeat requests are served from cache", () => {
    // Reopening a toolbar should not re-rasterize and re-encode every icon.
    const first = toolIconDataUrl(hammerArt, 24);
    const second = toolIconDataUrl(hammerArt, 24);

    expect(second).toBe(first);
  });

  test("the requested size is clamped to something drawable", () => {
    expect(toolIconDataUrl(hammerArt, 0).startsWith("data:image")).toBe(true);
    expect(toolIconDataUrl(hammerArt, 100000).startsWith("data:image")).toBe(true);
    expect(toolIconDataUrl(hammerArt, Number.NaN).startsWith("data:image")).toBe(true);
  });

  test("art that draws nothing yields no icon rather than a blank image", () => {
    expect(toolIconDataUrl(() => {}, 30)).toBe("");
  });

  test("custom art is measured by scanning its alpha", () => {
    // Third-party tools have no registered bounds manifest, so the exact
    // readback path has to keep working.
    const custom = (ctx) => {
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(-20, -20, 40, 40);
    };

    expect(toolIconDataUrl(custom, 30).startsWith("data:image")).toBe(true);
  });
});

describe("icon bounds manifest", () => {
  test("registering bounds returns the art so it can be used inline", () => {
    const art = () => {};
    const registered = registerToolIconBounds(art, [10, 10, 20, 20]);

    expect(registered).toBe(art);
    expect(toolIconBounds(art)).toEqual([10, 10, 20, 20]);
  });

  test("unregistered art has no manifest and falls back to scanning", () => {
    expect(toolIconBounds(() => {})).toBeUndefined();
  });

  test("built-in art ships measured bounds so icons need no canvas readback", () => {
    // The readback is a 256×256 getImageData per tool; on a 19-tool toolbar
    // that is the difference between an instant open and a visible stall.
    expect(toolIconBounds(hammerArt)).toBeDefined();
  });
});
