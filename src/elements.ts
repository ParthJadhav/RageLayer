/**
 * A map of the real page's furniture.
 *
 * Every other tool destroys pixels: it punches a circle, burns a blob, cuts a
 * line — the page is just a texture. This module is what lets the toy destroy
 * *things*. Before the DOM is hidden, it walks the capture root and records the
 * document-space rect of every meaningful piece of content — each heading,
 * paragraph, image, button, card — so the demolition tool can knock a whole
 * heading off the page as one rigid object that tumbles and lands intact.
 *
 * The walk happens once, at capture time, while the real layout still exists.
 */

/** Hard cap: a large app page can have thousands of nodes, and we only need furniture. */
const MAX_ELEMENTS = 500;
/**
 * Size floor for a demolition target.
 *
 * This number is doing real work, and the response to it is a cliff rather than
 * a slope. Once the floor drops low enough for tag pills and icons to qualify
 * on their own, they displace their own parents under the innermost-candidate
 * rule below — measured on a typical marketing page, dropping from 1600 to 900
 * took the target list from 55 sensible pieces of furniture (median ~100×66) to
 * 885 fragments (median ~37×37). Demolition then knocks 29×20 crumbs off a
 * heading, which reads as a bug and not as demolition.
 *
 * 1600 (~50×32 at desktop widths) sits just above that cliff: buttons and small
 * cards still count, individual chips do not.
 */
const MIN_AREA = 1600;
const MIN_SIDE = 18;
/**
 * A child that fills most of its parent means the parent is just a wrapper —
 * demolishing it would take the child with it and the granularity would be
 * "the whole page" on most modern layouts.
 */
const WRAPPER_CHILD_RATIO = 0.55;

export interface PageElement {
  /** Document coordinates, CSS px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Roughly how solid this looked — cards fracture, bare text shears off. */
  solid: boolean;
  /** Already knocked loose; a second hit should find the thing behind it. */
  taken: boolean;
}

const REPLACED = new Set(["IMG", "SVG", "VIDEO", "CANVAS", "PICTURE"]);
const SKIP = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "HEAD",
  "LINK",
  "META",
  "BR",
  "HR",
]);

function documentRect(el: Element, scrollX: number, scrollY: number) {
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
}

/**
 * Harvest the page's furniture. `filter` is the engine's capture filter, so the
 * RageLayer's own toolbar and framework dev overlays never become targets.
 */
export function harvestElements(
  root: HTMLElement,
  filter: (node: HTMLElement) => boolean,
): PageElement[] {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const rootArea = Math.max(1, root.scrollWidth * root.scrollHeight);

  const candidates: HTMLElement[] = [];
  const rects = new Map<HTMLElement, { x: number; y: number; w: number; h: number }>();

  const walk = (el: HTMLElement) => {
    if (candidates.length >= MAX_ELEMENTS * 3) return;
    if (SKIP.has(el.tagName) || !filter(el)) return;

    const rect = documentRect(el, scrollX, scrollY);
    rects.set(el, rect);
    const area = rect.w * rect.h;
    // Zero-size subtrees (collapsed, `display: none`) hold nothing to destroy.
    if (area <= 0) return;

    const children = Array.from(el.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && !SKIP.has(c.tagName),
    );
    for (const child of children) walk(child);

    if (REPLACED.has(el.tagName)) {
      if (area >= MIN_AREA) candidates.push(el);
      return;
    }
    if (area < MIN_AREA || rect.w < MIN_SIDE || rect.h < MIN_SIDE) return;
    // A single element covering most of the page is the page, not furniture.
    if (area > rootArea * 0.55) return;
    // Wrapper test: an element whose child fills it adds no new granularity.
    for (const child of children) {
      const cr = rects.get(child);
      if (cr && cr.w * cr.h > area * WRAPPER_CHILD_RATIO) return;
    }
    // Something has to actually be visible inside it.
    if (children.length === 0 && !el.textContent?.trim()) return;
    candidates.push(el);
  };

  for (const child of Array.from(root.children)) {
    if (child instanceof HTMLElement) walk(child);
  }

  // Keep the innermost candidates: if a section and its paragraphs both
  // qualified, the paragraphs are the interesting demolition targets.
  const ancestors = new Set<Element>();
  for (const el of candidates) {
    let p = el.parentElement;
    while (p) {
      ancestors.add(p);
      p = p.parentElement;
    }
  }

  const out: PageElement[] = [];
  for (const el of candidates) {
    if (ancestors.has(el)) continue;
    const rect = rects.get(el)!;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || Number(style.opacity) < 0.06) continue;
    const bg = style.backgroundColor;
    const solid =
      REPLACED.has(el.tagName) ||
      (bg !== "transparent" && bg !== "rgba(0, 0, 0, 0)") ||
      style.borderTopWidth !== "0px" ||
      style.boxShadow !== "none";
    out.push({ ...rect, solid, taken: false });
  }
  // Over the cap, keep the biggest rather than the first: truncating in DOM
  // order would leave everything below the fold undemolishable on a long page.
  if (out.length > MAX_ELEMENTS) {
    out.sort((a, b) => b.w * b.h - a.w * a.h);
    out.length = MAX_ELEMENTS;
  }
  return out;
}

/**
 * Smallest untaken element containing (x, y), growing the hit box by `slack`.
 *
 * Smallest, not first: overlapping targets should resolve to the thing you can
 * actually see under the cursor.
 *
 * The slack matters more than it looks. A line of body text is ~26 px tall, and
 * demanding a pixel-exact hit on it makes the demolition tool feel broken —
 * most clicks land in the leading between two paragraphs and get the fallback.
 * Elements that genuinely contain the point still win, because the containment
 * test runs first.
 */
export function elementAt(
  list: PageElement[],
  x: number,
  y: number,
  slack = 0,
): PageElement | null {
  let best: PageElement | null = null;
  let bestArea = Infinity;
  let slackBest: PageElement | null = null;
  let slackArea = Infinity;
  for (const el of list) {
    if (el.taken) continue;
    const inside = x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h;
    const area = el.w * el.h;
    if (inside) {
      if (area < bestArea) {
        bestArea = area;
        best = el;
      }
      continue;
    }
    if (slack <= 0 || best) continue;
    if (x < el.x - slack || x > el.x + el.w + slack) continue;
    if (y < el.y - slack || y > el.y + el.h + slack) continue;
    if (area < slackArea) {
      slackArea = area;
      slackBest = el;
    }
  }
  return best ?? slackBest;
}

/** Untaken elements intersecting a document-space band, nearest-to-`fromY` first. */
export function elementsInBand(
  list: PageElement[],
  top: number,
  bottom: number,
  fromY: number,
): PageElement[] {
  return list
    .filter((el) => !el.taken && el.y + el.h > top && el.y < bottom)
    .sort((a, b) => Math.abs(a.y - fromY) - Math.abs(b.y - fromY));
}
