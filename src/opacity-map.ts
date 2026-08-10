/**
 * OpacityMap — the CPU-side answer to "does the page still exist here?".
 *
 * Every page-aware effect asks that many times a frame (a hammer swung at a
 * hole meets nothing), and reading the visible canvas back would stall the GPU
 * pipeline every time. So coverage is tracked separately from the pixels: a
 * low-resolution snapshot of the pristine alpha, plus the wounds since,
 * retained as spatially indexed `Path2D` ops and queried with
 * `isPointInPath`/`isPointInStroke` — no readback at all. Walking them newest
 * first also models repair exactly: the latest shape containing the point wins.
 *
 * Alongside runs a coarser three-state topology grid (pristine void /
 * surviving material / removed material), which `topology.ts` walks to find
 * pieces the chainsaw has disconnected from the rest of the page.
 */

import { TAU } from "./math";
import { pointInPolygon } from "./topology";

/** Coarse enough to resolve the chainsaw's 4–7px kerf, compact enough for tall pages. */
const TOPOLOGY_CELL = 3;

/**
 * Per-cell operation list length that triggers flattening into the resolved
 * wound plane. Bounds both `sample()`'s worst-case walk and total retained
 * `Path2D` state — sustained fire used to grow one cell's list without limit.
 */
const FLATTEN_THRESHOLD = 32;

export interface OpacityBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface OpacityOperation {
  restores: boolean;
  bounds: OpacityBounds;
  fill: Path2D;
  stroke?: Path2D;
  lineWidth?: number;
  /** Index cells still referencing this op; freed when it reaches zero. */
  cells?: number;
}

/**
 * CPU-readable coverage for page-aware effects.
 *
 * The pristine alpha is captured once at low resolution. Wounds themselves are
 * retained as spatially indexed Path2D operations and queried with
 * isPointInPath/isPointInStroke, which does no pixel readback at all. Reverse
 * operation order also models repair exactly: the latest remove/restore shape
 * that contains the point wins.
 *
 * Recent wounds stay exact. Once a cell's list exceeds `FLATTEN_THRESHOLD`
 * its accumulated ops are rasterized — in order, clipped to the cell — into a
 * map-resolution "removed" plane and the list is cleared, so a long
 * flamethrower session cannot grow either query time or retained geometry
 * without bound. The plane holds a strictly older prefix of the history than
 * any surviving list entry, so the newest-op-wins walk stays correct; only
 * wounds old enough to be flattened trade exact geometry for map-pixel
 * resolution (the same resolution the pristine alpha itself is stored at).
 */
export class OpacityMap {
  private readonly raster = document.createElement("canvas");
  private readonly rasterCtx = this.raster.getContext("2d", { willReadFrequently: true })!;
  private readonly testCtx = document.createElement("canvas").getContext("2d")!;
  private baseAlpha: Uint8Array | null = null;
  private operations: (OpacityOperation | undefined)[] = [];
  private cells = new Map<number, number[]>();
  /** Resolved old wounds at map resolution: 255 where material was removed. */
  private removed: Uint8Array | null = null;
  private removedCanvas: HTMLCanvasElement | null = null;
  private removedCtx: CanvasRenderingContext2D | null = null;
  private scaleX = 1;
  private scaleY = 1;
  private mapWidth = 0;
  private mapHeight = 0;
  private cols = 1;
  private width = 0;
  private height = 0;
  /** 0 = pristine void, 1 = material, 2 = removed material. */
  private topology = new Uint8Array(0);
  private topologyCols = 0;
  private topologyRows = 0;

  reset(source: HTMLCanvasElement, width: number, height: number) {
    const scale = Math.min(1, Math.sqrt(2_000_000 / Math.max(1, width * height)));
    const mapWidth = Math.max(1, Math.ceil(width * scale));
    const mapHeight = Math.max(1, Math.ceil(height * scale));
    this.raster.width = mapWidth;
    this.raster.height = mapHeight;
    this.width = width;
    this.height = height;
    this.mapWidth = mapWidth;
    this.mapHeight = mapHeight;
    this.scaleX = mapWidth / width;
    this.scaleY = mapHeight / height;
    this.cols = Math.max(1, Math.ceil(width / 128));
    this.operations.length = 0;
    this.cells.clear();
    this.dropRemovedPlane();

    // Preserve transparent areas in unusual captures instead of assuming that
    // every pristine page is opaque. This one downscaled read happens during
    // capture, never in an interaction frame.
    const ctx = this.rasterCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, mapWidth, mapHeight);
    const alpha = new Uint8Array(mapWidth * mapHeight);
    try {
      const pixels = ctx.getImageData(0, 0, mapWidth, mapHeight).data;
      for (let src = 3, dst = 0; dst < alpha.length; src += 4, dst++) alpha[dst] = pixels[src];
    } catch {
      // Cross-origin pixels can taint an otherwise usable capture. Match the
      // old fallback and treat the pristine page as intact.
      alpha.fill(255);
    }
    this.baseAlpha = alpha;
    this.rebuildTopology();
    // Only the Uint8 alpha plane is retained; release the temporary RGBA
    // backing immediately (up to 8 MB at the map budget).
    this.raster.width = 0;
    this.raster.height = 0;
  }

  remove(path: Path2D, bounds: OpacityBounds, topologyPolygons?: number[][]) {
    const operation = { restores: false, bounds, fill: path } satisfies OpacityOperation;
    if (topologyPolygons) {
      for (const polygon of topologyPolygons) this.rasterizeTopologyPolygon(polygon);
      this.add(operation, true);
      return;
    }
    this.add(operation);
  }

  removeDisc(path: Path2D, bounds: OpacityBounds, x: number, y: number, radius: number) {
    this.rasterizeTopologyDisc(x, y, radius, false);
    this.add({ restores: false, bounds, fill: path }, true);
  }

  removeCut(kerf: Path2D, nicks: Path2D, lineWidth: number, bounds: OpacityBounds) {
    this.add({ restores: false, bounds, fill: nicks, stroke: kerf, lineWidth });
  }

  restoreDisc(x: number, y: number, r: number) {
    const path = new Path2D();
    path.arc(x, y, r, 0, TAU);
    this.rasterizeTopologyDisc(x, y, r, true);
    this.add(
      {
        restores: true,
        bounds: { x0: x - r, y0: y - r, x1: x + r, y1: y + r },
        fill: path,
      },
      true,
    );
  }

  restoreAll() {
    this.operations.length = 0;
    this.cells.clear();
    this.dropRemovedPlane();
    this.rebuildTopology();
  }

  /** Rebuild the compact hit-test/topology state from a restored surface snapshot. */
  restoreState(source: HTMLCanvasElement) {
    const base = this.baseAlpha;
    if (!base || this.mapWidth <= 0 || this.mapHeight <= 0) return;
    this.operations.length = 0;
    this.cells.clear();
    this.dropRemovedPlane();

    this.raster.width = this.mapWidth;
    this.raster.height = this.mapHeight;
    const ctx = this.rasterCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.mapWidth, this.mapHeight);
    ctx.drawImage(source, 0, 0, this.mapWidth, this.mapHeight);
    try {
      const pixels = ctx.getImageData(0, 0, this.mapWidth, this.mapHeight).data;
      const removed = new Uint8Array(base.length);
      let any = false;
      for (let src = 3, dst = 0; dst < removed.length; src += 4, dst++) {
        if (base[dst] >= 77 && pixels[src] < 77) {
          removed[dst] = 255;
          any = true;
        }
      }
      if (any) {
        const canvas = document.createElement("canvas");
        canvas.width = this.mapWidth;
        canvas.height = this.mapHeight;
        const removedCtx = canvas.getContext("2d", { willReadFrequently: true })!;
        const image = removedCtx.createImageData(this.mapWidth, this.mapHeight);
        for (let src = 0, dst = 3; src < removed.length; src++, dst += 4) {
          image.data[dst] = removed[src];
        }
        removedCtx.putImageData(image, 0, 0);
        this.removed = removed;
        this.removedCanvas = canvas;
        this.removedCtx = removedCtx;
      }
    } catch {
      // A tainted source remains renderable. In that rare case history restores
      // visuals exactly and hit testing conservatively falls back to pristine.
    }
    this.rebuildTopology();
    if (this.removed) {
      for (let row = 0; row < this.topologyRows; row++) {
        const y = Math.min(this.height - 0.01, (row + 0.5) * TOPOLOGY_CELL);
        const py = Math.min(this.mapHeight - 1, Math.floor(y * this.scaleY));
        for (let col = 0; col < this.topologyCols; col++) {
          const x = Math.min(this.width - 0.01, (col + 0.5) * TOPOLOGY_CELL);
          const px = Math.min(this.mapWidth - 1, Math.floor(x * this.scaleX));
          if (this.removed[py * this.mapWidth + px]) {
            this.topology[row * this.topologyCols + col] = 2;
          }
        }
      }
    }
    this.raster.width = 0;
    this.raster.height = 0;
  }

  sample(x: number, y: number): number {
    const base = this.baseAlpha;
    if (!base || x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const px = Math.min(this.mapWidth - 1, Math.floor(x * this.scaleX));
    const py = Math.min(this.mapHeight - 1, Math.floor(y * this.scaleY));
    const pristine = base[py * this.mapWidth + px] / 255;
    const cell = this.cells.get(Math.floor(y / 128) * this.cols + Math.floor(x / 128));
    if (cell) {
      for (let i = cell.length - 1; i >= 0; i--) {
        const operation = this.operations[cell[i]]!;
        const b = operation.bounds;
        if (x < b.x0 || y < b.y0 || x > b.x1 || y > b.y1) continue;
        let hit = this.testCtx.isPointInPath(operation.fill, x, y);
        if (!hit && operation.stroke) {
          this.testCtx.lineCap = "round";
          this.testCtx.lineWidth = operation.lineWidth ?? 1;
          hit = this.testCtx.isPointInStroke(operation.stroke, x, y);
        }
        if (hit) return operation.restores ? pristine : 0;
      }
    }
    // No live op decides this point; older, flattened history might.
    if (this.removed?.[py * this.mapWidth + px]) return 0;
    return pristine;
  }

  /** 0 = pristine void, 1 = surviving material, 2 = structurally removed. */
  stateAt(x: number, y: number): 0 | 1 | 2 {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || this.topology.length === 0)
      return 0;
    const c = Math.min(this.topologyCols - 1, Math.floor(x / TOPOLOGY_CELL));
    const r = Math.min(this.topologyRows - 1, Math.floor(y / TOPOLOGY_CELL));
    return this.topology[r * this.topologyCols + c] as 0 | 1 | 2;
  }

  dispose() {
    this.baseAlpha = null;
    this.operations.length = 0;
    this.cells.clear();
    this.dropRemovedPlane();
    this.topology = new Uint8Array(0);
    this.topologyCols = this.topologyRows = 0;
    this.raster.width = 0;
    this.raster.height = 0;
    // The hit-test context's backing canvas (browser-default 300×150) holds
    // pixels too; zero it like the raster so a disposed map retains nothing.
    this.testCtx.canvas.width = 0;
    this.testCtx.canvas.height = 0;
    this.mapWidth = this.mapHeight = this.width = this.height = 0;
  }

  private add(operation: OpacityOperation, topologyHandled = false) {
    if (!this.baseAlpha) return;
    if (!topologyHandled) this.rasterizeTopology(operation);
    const index = this.operations.push(operation) - 1;
    const b = operation.bounds;
    const x0 = Math.max(0, Math.floor(b.x0 / 128));
    const y0 = Math.max(0, Math.floor(b.y0 / 128));
    const x1 = Math.min(this.cols - 1, Math.floor(b.x1 / 128));
    const y1 = Math.min(Math.ceil(this.height / 128) - 1, Math.floor(b.y1 / 128));
    if (x1 < x0 || y1 < y0) {
      // Entirely off the page: no cell will ever query it, drop it now.
      this.operations[index] = undefined;
      return;
    }
    // The refcount must be final before any flatten below can decrement it.
    operation.cells = (x1 - x0 + 1) * (y1 - y0 + 1);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const key = ty * this.cols + tx;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(index);
        if (list.length > FLATTEN_THRESHOLD) this.flattenCell(key, list);
      }
    }
  }

  /**
   * Rasterize a cell's accumulated ops — in insertion order, clipped to the
   * cell — into the resolved wound plane, then clear the list. Ops no longer
   * referenced by any cell are freed. Runs off the per-query path, at most
   * once per `FLATTEN_THRESHOLD` wounds landing in one 128px cell.
   */
  private flattenCell(key: number, list: number[]) {
    if (!this.removedCanvas) {
      this.removedCanvas = document.createElement("canvas");
      this.removedCanvas.width = this.mapWidth;
      this.removedCanvas.height = this.mapHeight;
      this.removedCtx = this.removedCanvas.getContext("2d", { willReadFrequently: true })!;
      this.removed = new Uint8Array(this.mapWidth * this.mapHeight);
    }
    const ctx = this.removedCtx!;
    const cellX = (key % this.cols) * 128;
    const cellY = Math.floor(key / this.cols) * 128;
    const w = Math.min(128, this.width - cellX);
    const h = Math.min(128, this.height - cellY);
    if (w > 0 && h > 0) {
      ctx.save();
      ctx.setTransform(this.scaleX, 0, 0, this.scaleY, 0, 0);
      ctx.beginPath();
      ctx.rect(cellX, cellY, w, h);
      ctx.clip();
      ctx.fillStyle = "#000";
      ctx.strokeStyle = "#000";
      ctx.lineCap = "round";
      for (const index of list) {
        const op = this.operations[index]!;
        // Removes accumulate opacity; restores erase it, exactly mirroring the
        // "latest op wins" walk this plane replaces for flattened history.
        ctx.globalCompositeOperation = op.restores ? "destination-out" : "source-over";
        ctx.fill(op.fill);
        if (op.stroke) {
          ctx.lineWidth = op.lineWidth ?? 1;
          ctx.stroke(op.stroke);
        }
      }
      ctx.restore();

      // Mirror the flattened region into the CPU plane `sample()` reads.
      const mx0 = Math.max(0, Math.floor(cellX * this.scaleX));
      const my0 = Math.max(0, Math.floor(cellY * this.scaleY));
      const mx1 = Math.min(this.mapWidth, Math.ceil((cellX + w) * this.scaleX));
      const my1 = Math.min(this.mapHeight, Math.ceil((cellY + h) * this.scaleY));
      if (mx1 > mx0 && my1 > my0) {
        const data = ctx.getImageData(mx0, my0, mx1 - mx0, my1 - my0).data;
        const removed = this.removed!;
        for (let y = my0, src = 3; y < my1; y++) {
          let dst = y * this.mapWidth + mx0;
          for (let x = mx0; x < mx1; x++, src += 4, dst++) {
            removed[dst] = data[src] >= 128 ? 255 : 0;
          }
        }
      }
    }
    for (const index of list) {
      const op = this.operations[index]!;
      op.cells = (op.cells ?? 1) - 1;
      if (op.cells === 0) this.operations[index] = undefined;
    }
    list.length = 0;
  }

  private dropRemovedPlane() {
    this.removed = null;
    if (this.removedCanvas) {
      this.removedCanvas.width = 0;
      this.removedCanvas.height = 0;
    }
    this.removedCanvas = null;
    this.removedCtx = null;
  }

  private pristineStateAt(x: number, y: number): 0 | 1 {
    const base = this.baseAlpha;
    if (!base || x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const px = Math.min(this.mapWidth - 1, Math.floor(x * this.scaleX));
    const py = Math.min(this.mapHeight - 1, Math.floor(y * this.scaleY));
    return base[py * this.mapWidth + px] >= 77 ? 1 : 0;
  }

  private rebuildTopology() {
    if (!this.baseAlpha || this.width <= 0 || this.height <= 0) {
      this.topology = new Uint8Array(0);
      this.topologyCols = this.topologyRows = 0;
      return;
    }
    this.topologyCols = Math.max(1, Math.ceil(this.width / TOPOLOGY_CELL));
    this.topologyRows = Math.max(1, Math.ceil(this.height / TOPOLOGY_CELL));
    const size = this.topologyCols * this.topologyRows;
    const topology = this.topology.length === size ? this.topology : new Uint8Array(size);
    for (let r = 0; r < this.topologyRows; r++) {
      const y = Math.min(this.height - 0.01, (r + 0.5) * TOPOLOGY_CELL);
      for (let c = 0; c < this.topologyCols; c++) {
        const x = Math.min(this.width - 0.01, (c + 0.5) * TOPOLOGY_CELL);
        topology[r * this.topologyCols + c] = this.pristineStateAt(x, y);
      }
    }
    this.topology = topology;
  }

  /** Apply one structural operation to the compact connectivity grid once. */
  private rasterizeTopology(operation: OpacityOperation) {
    if (this.topology.length === 0) return;
    const b = operation.bounds;
    const c0 = Math.max(0, Math.floor(b.x0 / TOPOLOGY_CELL));
    const r0 = Math.max(0, Math.floor(b.y0 / TOPOLOGY_CELL));
    const c1 = Math.min(this.topologyCols - 1, Math.floor(b.x1 / TOPOLOGY_CELL));
    const r1 = Math.min(this.topologyRows - 1, Math.floor(b.y1 / TOPOLOGY_CELL));
    const ctx = this.testCtx;
    if (operation.stroke) {
      ctx.lineCap = "round";
      ctx.lineWidth = operation.lineWidth ?? 1;
    }
    const offset = TOPOLOGY_CELL * 0.3;
    const probeOffsets = [0, 0, offset, offset, -offset, offset, offset, -offset, -offset, -offset];
    for (let r = r0; r <= r1; r++) {
      const y = Math.min(this.height - 0.01, (r + 0.5) * TOPOLOGY_CELL);
      for (let c = c0; c <= c1; c++) {
        const x = Math.min(this.width - 0.01, (c + 0.5) * TOPOLOGY_CELL);
        let hit = false;
        for (let p = 0; p < probeOffsets.length; p += 2) {
          const px = x + probeOffsets[p];
          const py = y + probeOffsets[p + 1];
          hit = ctx.isPointInPath(operation.fill, px, py);
          if (!hit && operation.stroke) hit = ctx.isPointInStroke(operation.stroke, px, py);
          if (hit) break;
        }
        if (!hit) continue;
        this.topology[r * this.topologyCols + c] = operation.restores
          ? this.pristineStateAt(x, y)
          : 2;
      }
    }
  }

  /** Fast path for engine-generated polygons whose vertices are already known. */
  private rasterizeTopologyPolygon(points: number[]) {
    if (this.topology.length === 0 || points.length < 6) return;
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
    const c0 = Math.max(0, Math.floor(minX / TOPOLOGY_CELL));
    const r0 = Math.max(0, Math.floor(minY / TOPOLOGY_CELL));
    const c1 = Math.min(this.topologyCols - 1, Math.floor(maxX / TOPOLOGY_CELL));
    const r1 = Math.min(this.topologyRows - 1, Math.floor(maxY / TOPOLOGY_CELL));
    for (let r = r0; r <= r1; r++) {
      const y = Math.min(this.height - 0.01, (r + 0.5) * TOPOLOGY_CELL);
      for (let c = c0; c <= c1; c++) {
        const x = Math.min(this.width - 0.01, (c + 0.5) * TOPOLOGY_CELL);
        if (pointInPolygon(points, x, y)) this.topology[r * this.topologyCols + c] = 2;
      }
    }
  }

  private rasterizeTopologyDisc(x: number, y: number, radius: number, restores: boolean) {
    if (this.topology.length === 0 || radius <= 0) return;
    const c0 = Math.max(0, Math.floor((x - radius) / TOPOLOGY_CELL));
    const r0 = Math.max(0, Math.floor((y - radius) / TOPOLOGY_CELL));
    const c1 = Math.min(this.topologyCols - 1, Math.floor((x + radius) / TOPOLOGY_CELL));
    const r1 = Math.min(this.topologyRows - 1, Math.floor((y + radius) / TOPOLOGY_CELL));
    // A cell touched by the physical disc is empty/whole for connectivity. The
    // half-cell expansion matches the cut grid's conservative kerf treatment.
    const reach = radius + TOPOLOGY_CELL * 0.5;
    const reach2 = reach * reach;
    for (let r = r0; r <= r1; r++) {
      const py = Math.min(this.height - 0.01, (r + 0.5) * TOPOLOGY_CELL);
      for (let c = c0; c <= c1; c++) {
        const px = Math.min(this.width - 0.01, (c + 0.5) * TOPOLOGY_CELL);
        const dx = px - x;
        const dy = py - y;
        if (dx * dx + dy * dy > reach2) continue;
        this.topology[r * this.topologyCols + c] = restores ? this.pristineStateAt(px, py) : 2;
      }
    }
  }
}
