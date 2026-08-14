/**
 * Turning page pixels into physics chunks.
 *
 * Two halves:
 *
 * - **Geometry.** `voronoiCells` splits a disc into irregular convex cells, the
 *   way a pane of glass actually breaks — radial-ish shards, biggest at the rim,
 *   no two alike. `gridCells` does the boring rectangular split, used when a
 *   whole page element is being demolished rather than shattered.
 * - **Baking.** `bakeChunk` cuts a polygon's worth of the pristine page raster
 *   into its own small, alpha-masked canvas. That is what makes a falling chunk
 *   look like a piece of *this* page instead of a grey box: the body just blits
 *   its sprite, and the physics never has to know about textures.
 */

import { rand, TAU } from "./math";
import { Body } from "./physics";

export interface ChunkSource {
  /** The pristine page raster (ContentLayer's base). */
  img: CanvasImageSource;
  /** Device pixels per CSS pixel in `img`. */
  dpr: number;
  /** Raster extent in CSS px, so chunks off the edge can be rejected. */
  width: number;
  height: number;
}

export interface BakeOptions {
  /** Composited over the chunk with `source-atop` — ice blue, char black. */
  tint?: string;
  /** Stroked around the cut edge so a shard reads as *broken off*. */
  edge?: string;
  edgeWidth?: number;
  /**
   * Skip the slab-side sprite (ice shards are thin and translucent; a wooden
   * underside on them reads wrong).
   */
  flat?: boolean;
  /** Reject chunks larger than this per side, CSS px. Default `MAX_CHUNK`. */
  maxSize?: number;
  /**
   * Maximum device-pixel area for each baked face. Oversized pieces keep their
   * exact outline and world-space size, but use a proportionally smaller
   * backing store so one page-sized island cannot allocate two giant canvases.
   */
  maxPixels?: number;
}

/** Chunks bigger than this (CSS px per side) are wasteful to bake. */
const MAX_CHUNK = 420;
const MIN_CHUNK = 3;

/**
 * Cut `points` out of the page raster into a standalone sprite.
 *
 * Returns the sprite plus where it sits relative to the polygon's AABB centre;
 * the caller pairs that with the Body's centroid to get the draw offset.
 */
export function bakeChunk(
  source: ChunkSource,
  points: number[],
  options: BakeOptions = {},
): {
  sprite: HTMLCanvasElement;
  side: HTMLCanvasElement | null;
  cx: number;
  cy: number;
  w: number;
  h: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    if (points[i] < minX) minX = points[i];
    if (points[i] > maxX) maxX = points[i];
    if (points[i + 1] < minY) minY = points[i + 1];
    if (points[i + 1] > maxY) maxY = points[i + 1];
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const cap = options.maxSize ?? MAX_CHUNK;
  if (!(w > MIN_CHUNK) || !(h > MIN_CHUNK) || w > cap || h > cap) return null;
  // Fully outside the captured page: there are no pixels to carry.
  if (maxX < 0 || maxY < 0 || minX > source.width || minY > source.height) return null;

  const sourceDpr = source.dpr;
  const pixelBudget = options.maxPixels ?? Infinity;
  const d = Math.min(sourceDpr, Math.sqrt(pixelBudget / (w * h)));
  const sprite = document.createElement("canvas");
  sprite.width = Math.max(1, Math.round(w * d));
  sprite.height = Math.max(1, Math.round(h * d));
  const ctx = sprite.getContext("2d")!;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.drawImage(
    source.img,
    minX * sourceDpr,
    minY * sourceDpr,
    w * sourceDpr,
    h * sourceDpr,
    0,
    0,
    w,
    h,
  );

  // Mask to the polygon. `destination-in` is what gives shards their jagged
  // silhouette — a rectangular chunk of page never reads as broken.
  const path = new Path2D();
  path.moveTo(points[0] - minX, points[1] - minY);
  for (let i = 2; i < points.length; i += 2) path.lineTo(points[i] - minX, points[i + 1] - minY);
  path.closePath();
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = "#fff";
  ctx.fill(path);

  if (options.tint) {
    ctx.globalCompositeOperation = "source-atop";
    ctx.fillStyle = options.tint;
    ctx.fillRect(0, 0, w, h);
  }
  if (options.edge) {
    // Drawn last, inside the mask, so the highlight follows the torn edge.
    ctx.globalCompositeOperation = "source-atop";
    ctx.strokeStyle = options.edge;
    ctx.lineWidth = options.edgeWidth ?? 1.4;
    ctx.lineJoin = "round";
    ctx.stroke(path);
  }
  ctx.globalCompositeOperation = "source-over";

  // The slab's underside: the same silhouette filled with end-grain wood, drawn
  // under the face sprite at a small world-space offset by the physics
  // renderer. The sliver that protrudes past the face's silhouette is what
  // makes a tumbling chunk read as a thick board instead of a paper cutout.
  let side: HTMLCanvasElement | null = null;
  if (!options.flat) {
    side = document.createElement("canvas");
    side.width = sprite.width;
    side.height = sprite.height;
    const sctx = side.getContext("2d")!;
    sctx.setTransform(d, 0, 0, d, 0, 0);
    sctx.fillStyle = "#4a3826";
    sctx.fill(path);
    // Horizontal grain streaks, clipped to the silhouette.
    sctx.globalCompositeOperation = "source-atop";
    sctx.strokeStyle = "rgba(24, 17, 10, 0.5)";
    sctx.lineWidth = 1;
    // A page-height island does not need thousands of sub-pixel grain strokes
    // in a downsampled backing store. Keep their visible density bounded.
    const grainStep = Math.max(2.5, h / 360);
    for (let gy = 1.5; gy < h; gy += grainStep + Math.random() * grainStep) {
      sctx.beginPath();
      sctx.moveTo(0, gy);
      sctx.lineTo(w, gy + rand(-1, 1));
      sctx.stroke();
    }
    // The source sprite already contains every earlier hole and cut. Use that
    // alpha as the final material mask so the offset underside cannot paint
    // "wood" into a void merely because the new chunk's outer polygon spans it.
    sctx.globalCompositeOperation = "destination-in";
    sctx.drawImage(sprite, 0, 0, w, h);
    sctx.globalCompositeOperation = "source-over";
  }

  return { sprite, side, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w, h };
}

/**
 * Build a physics body from a polygon plus its baked page pixels.
 *
 * `collisionPoints` substitutes a different (convex) outline for the physics
 * shape while the sprite keeps the drawn polygon — used by chainsaw cut-outs,
 * whose traced loops are rarely convex. The solver's face-normal math assumes
 * convexity, so handing it the hull keeps contacts sane while the sprite still
 * shows exactly what was cut.
 */
export function makeChunk(
  source: ChunkSource,
  points: number[],
  init: Omit<ConstructorParameters<typeof Body>[0], "points" | "sprite"> = {},
  bake: BakeOptions = {},
  collisionPoints?: number[],
): Body | null {
  const baked = bakeChunk(source, points, bake);
  if (!baked) return null;
  const body = new Body({ ...init, points: collisionPoints ?? points, sprite: baked.sprite });
  // The sprite covers the polygon's AABB; the body pivots about its centroid.
  body.spriteX = baked.cx - body.x;
  body.spriteY = baked.cy - body.y;
  body.spriteW = baked.w;
  body.spriteH = baked.h;
  body.sideSprite = baked.side;
  return body;
}

/**
 * Convex hull (Andrew's monotone chain) of a flat x0,y0,x1,y1,… point list.
 * Returned in the same flat format, counter-clockwise in screen space.
 */
export function convexHull(points: number[]): number[] {
  const n = points.length / 2;
  if (n < 3) return points.slice();
  const idx = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => points[a * 2] - points[b * 2] || points[a * 2 + 1] - points[b * 2 + 1],
  );
  const cross = (o: number, a: number, b: number) =>
    (points[a * 2] - points[o * 2]) * (points[b * 2 + 1] - points[o * 2 + 1]) -
    (points[a * 2 + 1] - points[o * 2 + 1]) * (points[b * 2] - points[o * 2]);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) {
      lower.pop();
    }
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) {
      upper.pop();
    }
    upper.push(i);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  const out: number[] = [];
  for (const i of hull) out.push(points[i * 2], points[i * 2 + 1]);
  return out;
}

/** Clip a convex polygon by the half-plane `n · p <= c` (Sutherland–Hodgman). */
function clipHalfPlane(poly: number[], nx: number, ny: number, c: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = poly[i * 2];
    const y0 = poly[i * 2 + 1];
    const x1 = poly[j * 2];
    const y1 = poly[j * 2 + 1];
    const d0 = nx * x0 + ny * y0 - c;
    const d1 = nx * x1 + ny * y1 - c;
    if (d0 <= 0) out.push(x0, y0);
    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1);
      out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  }
  return out;
}

/**
 * Voronoi shatter: split a rough disc at (cx, cy) into `count` convex cells.
 *
 * Sites are biased toward the impact point (`Math.random() ** 1.7`), which is
 * what produces the real pattern — a spray of small fragments at the centre
 * opening out into big plates at the rim — rather than uniform confetti.
 */
export function voronoiCells(cx: number, cy: number, radius: number, count: number): number[][] {
  const sites: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const d = radius * Math.random() ** 1.7;
    sites.push(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
  }

  // Outer boundary: a jittered polygon, so the shattered region has a ragged
  // rim instead of a suspiciously circular one.
  const sides = 13;
  const hull: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * TAU;
    const r = radius * (0.86 + Math.random() * 0.34);
    hull.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }

  const cells: number[][] = [];
  for (let i = 0; i < count; i++) {
    let cell = hull;
    const sx = sites[i * 2];
    const sy = sites[i * 2 + 1];
    for (let j = 0; j < count && cell.length >= 6; j++) {
      if (j === i) continue;
      const ox = sites[j * 2];
      const oy = sites[j * 2 + 1];
      const nx = ox - sx;
      const ny = oy - sy;
      const len = Math.hypot(nx, ny);
      if (len < 1e-6) continue;
      // Perpendicular bisector: keep the side nearer to site i.
      const ux = nx / len;
      const uy = ny / len;
      const c = ux * ((sx + ox) / 2) + uy * ((sy + oy) / 2);
      // Most bisectors never reach the current cell. If every vertex is
      // already on the kept side the clip is the identity, so skip it — these
      // are the same `d0` dot products `clipHalfPlane` would compute, so the
      // surviving geometry is bit-identical, just without copying the cell
      // O(count) times per shard.
      let cut = false;
      for (let k = 0; k < cell.length; k += 2) {
        if (ux * cell[k] + uy * cell[k + 1] - c > 0) {
          cut = true;
          break;
        }
      }
      if (cut) cell = clipHalfPlane(cell, ux, uy, c);
    }
    if (cell.length >= 6) cells.push(cell);
  }
  return cells;
}

/**
 * Rectangular split with jittered interior vertices. Used to demolish a page
 * element: a card should come apart into plausible panel-shaped pieces, not the
 * radial spray of a bullet strike.
 */
export function gridCells(
  x: number,
  y: number,
  w: number,
  h: number,
  cols: number,
  rows: number,
  jitter = 0.28,
): number[][] {
  const gx: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const edge = r === 0 || c === 0 || r === rows || c === cols;
      const jx = edge ? 0 : (Math.random() - 0.5) * (w / cols) * jitter * 2;
      const jy = edge ? 0 : (Math.random() - 0.5) * (h / rows) * jitter * 2;
      row.push(x + (c / cols) * w + jx, y + (r / rows) * h + jy);
    }
    gx.push(row);
  }
  const cells: number[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push([
        gx[r][c * 2],
        gx[r][c * 2 + 1],
        gx[r][(c + 1) * 2],
        gx[r][(c + 1) * 2 + 1],
        gx[r + 1][(c + 1) * 2],
        gx[r + 1][(c + 1) * 2 + 1],
        gx[r + 1][c * 2],
        gx[r + 1][c * 2 + 1],
      ]);
    }
  }
  return cells;
}

/** Pick a shard count that keeps big regions from blowing the body budget. */
export function shardBudget(radius: number, quality: number): number {
  return Math.max(4, Math.min(26, Math.round((radius / 16) * quality)));
}
