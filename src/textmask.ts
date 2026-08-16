/**
 * Text-rect mask — a quarter-resolution map of where the page has type on it.
 *
 * The surface shader bends and re-lights pixels near a tear. Applied uniformly
 * that also softens every glyph on the page, which reads as "the capture is
 * blurry" rather than as "the page is damaged". So the shader needs to know
 * which pixels are text, and back off there.
 *
 * `Range.getClientRects()` gives one rect per line box of a text node, which is
 * both cheaper and far tighter than per-element bounding boxes: a paragraph
 * contributes its actual lines rather than one block covering the whole column,
 * so the gaps between lines correctly count as non-text.
 *
 * Built once per capture, at `MASK_SCALE` — the shader samples it bilinearly
 * and only uses it to fade an effect, so quarter-res costs nothing visible and
 * a quarter of the memory in each dimension.
 */

/** Mask resolution relative to the page, in CSS px. */
const MASK_SCALE = 0.25;

/** Rects thinner than this in either axis are decorative, not type. */
const MIN_RECT = 1;

/**
 * Rasterize every text line and form field under `root` into a mask canvas.
 *
 * Coordinates are *document* space (the same space the content layer works in),
 * so the caller's scroll position doesn't leak into the result — this runs once
 * at capture time and the mask stays valid until the page reflows.
 *
 * `filter` is the same predicate the capture uses, so RageLayer's own
 * toolbar and framework dev tooling don't leave phantom text in the mask.
 */
export function buildTextMask(
  root: HTMLElement,
  width: number,
  height: number,
  filter: (node: HTMLElement) => boolean,
): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * MASK_SCALE));
  canvas.height = Math.max(1, Math.round(height * MASK_SCALE));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#fff";
  ctx.scale(MASK_SCALE, MASK_SCALE);
  const offsetX = window.scrollX;
  const offsetY = window.scrollY;

  // `filter` is checked per *element*, so a rejected subtree is skipped whole
  // rather than re-tested for each of its text nodes.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return filter(node as HTMLElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const range = document.createRange();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Form controls paint their own text, which no text node describes.
      const el = node as HTMLElement;
      const tag = el.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") continue;
      paint(ctx, el.getBoundingClientRect(), offsetX, offsetY, 0);
      continue;
    }
    const parent = node.parentElement;
    // `checkVisibility` catches `visibility: hidden` and `content-visibility`
    // subtrees that still have layout boxes and would otherwise mask blank page.
    if (!parent || (parent.checkVisibility && !parent.checkVisibility())) continue;
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      // Grown by a pixel so antialiased glyph edges land inside the mask.
      paint(ctx, rects[i], offsetX, offsetY, 1);
    }
  }
  return canvas;
}

function paint(
  ctx: CanvasRenderingContext2D,
  rect: DOMRect,
  offsetX: number,
  offsetY: number,
  grow: number,
) {
  if (rect.width < MIN_RECT || rect.height < MIN_RECT) return;
  ctx.fillRect(
    rect.left + offsetX - grow,
    rect.top + offsetY - grow,
    rect.width + grow * 2,
    rect.height + grow * 2,
  );
}
