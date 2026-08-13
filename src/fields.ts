/**
 * ScalarField — a coarse scalar grid laid over the whole document.
 *
 * Fire needs to know how much fuel remains at a point on the page. That is not
 * a per-pixel question, so a grid a few dozen pixels to a cell is cheap to
 * allocate, snapshot for undo, and walk while flames spread.
 */

/** A grid's contents plus the shape they were captured at (see `restore`). */
export interface FieldSnapshot {
  cols: number;
  rows: number;
  values: Float32Array;
}

export interface ScalarFieldOptions {
  /** Grid resolution: CSS px per cell. */
  cell: number;
  /** Upper clamp for stored values. */
  max: number;
  /** Value every cell starts (and is reset) at. */
  initial: number;
}

export class ScalarField {
  readonly cell: number;
  private readonly max: number;
  private readonly initial: number;
  private cols = 0;
  private rows = 0;
  /** Null until something actually writes to the field. */
  private values: Float32Array | null = null;

  constructor(options: ScalarFieldOptions) {
    this.cell = options.cell;
    this.max = options.max;
    this.initial = options.initial;
  }

  get allocated(): boolean {
    return this.values !== null;
  }

  /** Retained bytes, for the history budget. */
  get byteLength(): number {
    return this.values?.byteLength ?? 0;
  }

  /**
   * Allocate (or re-shape) the grid for a document of `width` × `height`.
   * A reflow invalidates the contents, so a shape change starts over.
   */
  ensure(width: number, height: number) {
    const cols = Math.max(1, Math.ceil(width / this.cell));
    const rows = Math.max(1, Math.ceil(height / this.cell));
    if (this.values && cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.values = new Float32Array(cols * rows).fill(this.initial);
  }

  /** Drop the grid entirely; the next `ensure` rebuilds it. */
  release() {
    this.values = null;
    this.cols = this.rows = 0;
  }

  /** Put every cell back to its starting value, keeping the allocation. */
  reset() {
    this.values?.fill(this.initial);
  }

  /** Value at a document point; off-grid reads clamp to the nearest edge cell. */
  at(x: number, y: number): number {
    const values = this.values;
    if (!values) return this.initial;
    let c = Math.floor(x / this.cell);
    let r = Math.floor(y / this.cell);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) {
      c = c < 0 ? 0 : Math.min(c, this.cols - 1);
      r = r < 0 ? 0 : Math.min(r, this.rows - 1);
    }
    return values[r * this.cols + c];
  }

  /**
   * Add `amount` to the cell under (x, y) and `amount * spill` to its four
   * neighbours — a fire burning through one board scorches the boards beside it
   * before they catch.
   */
  addCross(x: number, y: number, amount: number, spill: number) {
    const values = this.values;
    if (!values) return;
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cell)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cell)));
    const i = r * this.cols + c;
    values[i] = this.clamp(values[i] + amount);
    const bleed = amount * spill;
    for (const [nc, nr] of [
      [c - 1, r],
      [c + 1, r],
      [c, r - 1],
      [c, r + 1],
    ] as const) {
      if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
      const j = nr * this.cols + nc;
      values[j] = this.clamp(values[j] + bleed);
    }
  }

  /** Copy the contents out for an undo checkpoint. Null when never allocated. */
  snapshot(): FieldSnapshot | null {
    if (!this.values) return null;
    return { cols: this.cols, rows: this.rows, values: this.values.slice() };
  }

  /**
   * Put a checkpoint back. A snapshot taken before a reflow describes a grid of
   * a different shape and is dropped rather than reinstated at the wrong
   * stride — the field simply rebuilds from scratch on next use.
   */
  restore(snapshot: FieldSnapshot | null) {
    if (!snapshot) {
      this.release();
      return;
    }
    if (this.values && (snapshot.cols !== this.cols || snapshot.rows !== this.rows)) {
      this.release();
      return;
    }
    this.cols = snapshot.cols;
    this.rows = snapshot.rows;
    this.values = snapshot.values.slice();
  }

  private clamp(value: number): number {
    return value < 0 ? 0 : value > this.max ? this.max : value;
  }
}
