/**
 * Material-topology helpers.
 *
 * Destruction is not just drawing transparent pixels. A cut changes which
 * parts of the page are still connected to the surrounding sheet. These
 * helpers operate on the engine's CPU-readable opacity map so the chainsaw can
 * release actual islands of surviving material instead of guessing that a
 * cursor path "looks closed".
 */

export interface TopologyBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MaterialTopology {
  width: number;
  height: number;
  /** 0 = pristine void, 1 = surviving material, 2 = structurally removed. */
  stateAt(x: number, y: number): 0 | 1 | 2;
}

const MIN_DETACHED_AREA = 320;
const TARGET_CELL = 3;
const MAX_SCAN_CELLS = 72_000;

/** Signed twice-area. Magnitude works for either screen-space winding. */
export function polygonArea2(points: number[]): number {
  let area2 = 0;
  const n = points.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
  }
  return area2;
}

/** Even-odd containment also behaves sensibly for imperfect traced polygons. */
export function pointInPolygon(points: number[], x: number, y: number): boolean {
  let inside = false;
  const n = points.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xj = points[j * 2];
    const yj = points[j * 2 + 1];
    if (yi > y === yj > y) continue;
    const crossX = ((xj - xi) * (y - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (x < crossX) inside = !inside;
  }
  return inside;
}

/**
 * Estimate how many CSS-pixel square units of a polygon still contain page.
 * Used before baking physics sprites so explosions, demolition, and cut-outs
 * can never manufacture wooden chunks from an already-empty region.
 */
export function polygonMaterialArea(
  points: number[],
  opacityAt: (x: number, y: number) => number,
): number {
  if (points.length < 6) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxX = Math.max(maxX, points[i]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  const geometricArea = Math.abs(polygonArea2(points)) * 0.5;
  if (geometricArea <= 0) return 0;
  // Roughly 144 samples for an ordinary shard, bounded for a very large loop.
  const step = Math.max(3, Math.sqrt(((maxX - minX) * (maxY - minY)) / 196));
  let inside = 0;
  let material = 0;
  for (let y = minY + step * 0.5; y < maxY; y += step) {
    for (let x = minX + step * 0.5; x < maxX; x += step) {
      if (!pointInPolygon(points, x, y)) continue;
      inside++;
      material += opacityAt(x, y);
    }
  }
  if (inside > 0) return geometricArea * (material / inside);

  // Very thin polygons can fall between the grid samples. Their centroid is a
  // stable final probe and avoids rejecting a narrow but real shard outright.
  let cx = 0;
  let cy = 0;
  const n = points.length >> 1;
  for (let i = 0; i < points.length; i += 2) {
    cx += points[i];
    cy += points[i + 1];
  }
  return geometricArea * opacityAt(cx / n, cy / n);
}

function addEdge(
  starts: number[],
  ends: number[],
  adjacency: Map<number, number[]>,
  start: number,
  end: number,
) {
  const index = starts.push(start) - 1;
  ends.push(end);
  const outgoing = adjacency.get(start);
  if (outgoing) outgoing.push(index);
  else adjacency.set(start, [index]);
}

function edgeDirection(start: number, end: number, stride: number): number {
  if (end === start + 1) return 0; // east
  if (end === start + stride) return 1; // south
  if (end === start - 1) return 2; // west
  return 3; // north
}

function chooseNextEdge(
  candidates: number[],
  used: Uint8Array,
  starts: number[],
  ends: number[],
  previousDirection: number,
  stride: number,
): number {
  let best = -1;
  let bestRank = Infinity;
  // Keeping solid cells on the right means: right turn, straight, left, back.
  const turnRank = [1, 0, 3, 2];
  for (const edge of candidates) {
    if (used[edge]) continue;
    const direction = edgeDirection(starts[edge], ends[edge], stride);
    const delta = (direction - previousDirection + 4) % 4;
    const rank = turnRank.indexOf(delta);
    if (rank < bestRank) {
      bestRank = rank;
      best = edge;
    }
  }
  return best;
}

function traceOuterBoundary(
  labels: Int32Array,
  label: number,
  cols: number,
  rows: number,
  originX: number,
  originY: number,
  cell: number,
  boundX: number,
  boundY: number,
): number[] {
  const vertexStride = cols + 1;
  const starts: number[] = [];
  const ends: number[] = [];
  const adjacency = new Map<number, number[]>();
  const at = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < cols && r < rows && labels[r * cols + c] === label;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!at(c, r)) continue;
      const tl = r * vertexStride + c;
      const tr = tl + 1;
      const bl = tl + vertexStride;
      const br = bl + 1;
      // Clockwise around solid material (the solid remains on the right).
      if (!at(c, r - 1)) addEdge(starts, ends, adjacency, tl, tr);
      if (!at(c + 1, r)) addEdge(starts, ends, adjacency, tr, br);
      if (!at(c, r + 1)) addEdge(starts, ends, adjacency, br, bl);
      if (!at(c - 1, r)) addEdge(starts, ends, adjacency, bl, tl);
    }
  }

  const used = new Uint8Array(starts.length);
  let best: number[] = [];
  let bestArea = 0;
  for (let seed = 0; seed < starts.length; seed++) {
    if (used[seed]) continue;
    const vertices: number[] = [starts[seed]];
    let edge = seed;
    let guard = starts.length + 1;
    while (edge >= 0 && guard-- > 0) {
      used[edge] = 1;
      const end = ends[edge];
      if (end === vertices[0]) break;
      vertices.push(end);
      const outgoing = adjacency.get(end);
      if (!outgoing) break;
      const direction = edgeDirection(starts[edge], end, vertexStride);
      edge = chooseNextEdge(outgoing, used, starts, ends, direction, vertexStride);
    }
    if (vertices.length < 3) continue;

    const loop: number[] = [];
    for (const vertex of vertices) {
      const vx = vertex % vertexStride;
      const vy = Math.floor(vertex / vertexStride);
      // The last scan cell can be fractional. Keep its traced outer edge inside
      // the real page instead of manufacturing a few pixels past the capture.
      loop.push(Math.min(boundX, originX + vx * cell), Math.min(boundY, originY + vy * cell));
    }
    const area = Math.abs(polygonArea2(loop));
    if (area > bestArea) {
      bestArea = area;
      best = loop;
    }
  }

  // Remove straight grid vertices. This preserves every corner but avoids
  // feeding hundreds of redundant collinear points into Path2D and hull sort.
  if (best.length <= 6) return best;
  const compact: number[] = [];
  const n = best.length >> 1;
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    const q = (i + 1) % n;
    const ax = best[i * 2] - best[p * 2];
    const ay = best[i * 2 + 1] - best[p * 2 + 1];
    const bx = best[q * 2] - best[i * 2];
    const by = best[q * 2 + 1] - best[i * 2 + 1];
    if (ax * by - ay * bx === 0 && ax * bx + ay * by > 0) continue;
    compact.push(best[i * 2], best[i * 2 + 1]);
  }
  return compact;
}

/**
 * Find surviving material islands inside `bounds` that no longer connect to
 * the surrounding page. Local scan borders count as anchors; actual document
 * edges do not, which lets a cut use the edge of the page as part of its loop.
 * Existing holes naturally participate because connectivity comes from the
 * current opacity map, not from the shape of the pointer trail.
 */
export function findDetachedPolygons(source: MaterialTopology, bounds: TopologyBounds): number[][] {
  const padded = 24;
  let x0 = Math.max(0, bounds.x0 - padded);
  let y0 = Math.max(0, bounds.y0 - padded);
  let x1 = Math.min(source.width, bounds.x1 + padded);
  let y1 = Math.min(source.height, bounds.y1 + padded);
  if (x1 - x0 < 10 || y1 - y0 < 10) return [];

  let cell = TARGET_CELL;
  const scanArea = (x1 - x0) * (y1 - y0);
  if (scanArea / (cell * cell) > MAX_SCAN_CELLS) {
    cell = Math.sqrt(scanArea / MAX_SCAN_CELLS);
  }
  // Aligning to the grid keeps repeat scans stable as bounds grow.
  x0 = Math.max(0, Math.floor(x0 / cell) * cell);
  y0 = Math.max(0, Math.floor(y0 / cell) * cell);
  x1 = Math.min(source.width, Math.ceil(x1 / cell) * cell);
  y1 = Math.min(source.height, Math.ceil(y1 / cell) * cell);
  const cols = Math.max(1, Math.ceil((x1 - x0) / cell));
  const rows = Math.max(1, Math.ceil((y1 - y0) / cell));
  const total = cols * rows;
  const solid = new Uint8Array(total);
  const damaged = new Uint8Array(total);
  const labels = new Int32Array(total);
  labels.fill(-1);
  for (let r = 0; r < rows; r++) {
    const y = Math.min(source.height - 0.01, y0 + (r + 0.5) * cell);
    for (let c = 0; c < cols; c++) {
      const x = Math.min(source.width - 0.01, x0 + (c + 0.5) * cell);
      // Two staggered probes make a 4–7px kerf reliably topological on a 3px
      // grid without paying five Path2D hit-tests per cell. Treating either
      // probe as void expands a cut by less than one cell—the physical blade's
      // own tolerance—while closing alias-sized sampling gaps.
      const offset = cell * 0.28;
      const sx = Math.max(0, Math.min(source.width - 0.01, x + ((c + r) & 1 ? offset : -offset)));
      const sy = Math.max(0, Math.min(source.height - 0.01, y + ((c - r) & 1 ? offset : -offset)));
      const index = r * cols + c;
      const centre = source.stateAt(x, y);
      const staggered = source.stateAt(sx, sy);
      if (centre === 1 && staggered === 1) solid[index] = 1;
      if (centre === 2 || staggered === 2) damaged[index] = 1;
    }
  }

  const leftAnchors = x0 > 0.01;
  const topAnchors = y0 > 0.01;
  const rightAnchors = x1 < source.width - 0.01;
  const bottomAnchors = y1 < source.height - 0.01;
  const queue = new Int32Array(total);
  const components: { label: number; cells: number; touchesDamage: boolean; anchored: boolean }[] =
    [];
  let nextLabel = 0;

  for (let seed = 0; seed < total; seed++) {
    if (!solid[seed] || labels[seed] >= 0) continue;
    const label = nextLabel++;
    let head = 0;
    let tail = 0;
    let count = 0;
    let anchored = false;
    let touchesDamage = false;
    queue[tail++] = seed;
    labels[seed] = label;
    while (head < tail) {
      const index = queue[head++];
      count++;
      const c = index % cols;
      const r = Math.floor(index / cols);
      if ((c === 0 && leftAnchors) || (c === cols - 1 && rightAnchors)) anchored = true;
      if ((r === 0 && topAnchors) || (r === rows - 1 && bottomAnchors)) anchored = true;
      const neighbors = [index - cols, index + 1, index + cols, index - 1];
      const valid = [r > 0, c + 1 < cols, r + 1 < rows, c > 0];
      for (let k = 0; k < 4; k++) {
        if (!valid[k]) continue;
        const neighbor = neighbors[k];
        if (solid[neighbor]) {
          if (labels[neighbor] < 0) {
            labels[neighbor] = label;
            queue[tail++] = neighbor;
          }
          continue;
        }
        if (!touchesDamage && damaged[neighbor]) touchesDamage = true;
      }
    }
    components.push({ label, cells: count, touchesDamage, anchored });
  }

  // When the scan covers the entire document there is no local scan border to
  // act as a support. Keep one root sheet: prefer the component owning the most
  // original document corners, then the largest. This lets a one-corner piece
  // fall while the three-corner remainder stays put; an interior loop keeps
  // the four-corner outer sheet. It also prevents an open cut from releasing
  // the whole page merely because its accumulated bounds reached every edge.
  let rootLabel = -1;
  if (!leftAnchors && !topAnchors && !rightAnchors && !bottomAnchors && components.length) {
    const cornerCounts = new Int8Array(nextLabel);
    const cornerIndices = [0, cols - 1, (rows - 1) * cols, rows * cols - 1];
    for (const index of cornerIndices) {
      const label = labels[index];
      if (label >= 0) cornerCounts[label]++;
    }
    let rootCorners = -1;
    let rootCells = -1;
    for (const component of components) {
      const corners = cornerCounts[component.label];
      if (corners > rootCorners || (corners === rootCorners && component.cells > rootCells)) {
        rootLabel = component.label;
        rootCorners = corners;
        rootCells = component.cells;
      }
    }
  }

  const candidates = components.filter(
    (component) =>
      !component.anchored &&
      component.label !== rootLabel &&
      component.touchesDamage &&
      component.cells * cell * cell >= MIN_DETACHED_AREA,
  );
  candidates.sort((a, b) => b.cells - a.cells);
  const polygons: number[][] = [];
  // A single scribble can close several regions at once (for example a figure
  // eight). Release all useful islands, with a cap guarding malicious paths.
  for (let i = 0; i < Math.min(8, candidates.length); i++) {
    const polygon = traceOuterBoundary(
      labels,
      candidates[i].label,
      cols,
      rows,
      x0,
      y0,
      cell,
      x1,
      y1,
    );
    if (polygon.length >= 6) polygons.push(polygon);
  }
  return polygons;
}

export interface SurfaceRun {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  length: number;
}

/**
 * Clip a stroke to surviving material. A saw crossing a hole cuts the near and
 * far rims separately; it never paints a gash, throws sawdust, or builds a
 * structural connection across empty space.
 */
export function surfaceRuns(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  onSurface: (x: number, y: number) => boolean,
): SurfaceRun[] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return [];
  const steps = Math.max(1, Math.ceil(length / 3));
  const runs: SurfaceRun[] = [];
  let previousT = 0;
  let previousSolid = onSurface(x1, y1);
  let startT = previousSolid ? 0 : -1;

  const refine = (lo: number, hi: number, loSolid: boolean) => {
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) * 0.5;
      const solid = onSurface(x1 + dx * mid, y1 + dy * mid);
      if (solid === loSolid) lo = mid;
      else hi = mid;
    }
    return (lo + hi) * 0.5;
  };

  const append = (from: number, to: number) => {
    if (to - from <= 0.002) return;
    runs.push({
      x1: x1 + dx * from,
      y1: y1 + dy * from,
      x2: x1 + dx * to,
      y2: y1 + dy * to,
      length: length * (to - from),
    });
  };

  for (let step = 1; step <= steps; step++) {
    const t = step / steps;
    const solid = onSurface(x1 + dx * t, y1 + dy * t);
    if (solid !== previousSolid) {
      const boundary = refine(previousT, t, previousSolid);
      if (previousSolid) append(startT, boundary);
      else startT = boundary;
    }
    previousT = t;
    previousSolid = solid;
  }
  if (previousSolid) append(startT, 1);
  return runs;
}
