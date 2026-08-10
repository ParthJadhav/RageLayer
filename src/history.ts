export interface HistoryOptions {
  /** Maximum undo checkpoints retained. Default 6, clamped to 1..20. */
  maxEntries?: number;
  /** Maximum total canvas pixels retained across undo and redo. Default 24 million. */
  maxPixels?: number;
}

export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoDepth: number;
  readonly redoDepth: number;
}

export interface DestructionHistoryEntry {
  label?: string;
  timestamp: number;
  /** Canvas backing pixels retained by this entry. */
  pixelCost: number;
  dispose(): void;
}

/** Bounded, disposal-aware two-stack history used by the engine and reusable by SDK hosts. */
export class DestructionHistory<T extends DestructionHistoryEntry> {
  private readonly past: T[] = [];
  private readonly future: T[] = [];
  private readonly maxEntries: number;
  private readonly maxPixels: number;

  constructor(options: HistoryOptions = {}) {
    this.maxEntries = Math.max(1, Math.min(20, Math.round(options.maxEntries ?? 6)));
    this.maxPixels = Math.max(1, Math.round(options.maxPixels ?? 24_000_000));
  }

  get state(): HistoryState {
    return {
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      undoDepth: this.past.length,
      redoDepth: this.future.length,
    };
  }

  canStore(pixelCost: number): boolean {
    return pixelCost <= this.maxPixels;
  }

  push(entry: T): boolean {
    if (!this.canStore(entry.pixelCost)) {
      entry.dispose();
      return false;
    }
    this.disposeEntries(this.future);
    this.past.push(entry);
    this.enforceBudget();
    return true;
  }

  undo(current: T): T | null {
    const previous = this.past.pop();
    if (!previous) {
      current.dispose();
      return null;
    }
    if (current.pixelCost <= this.maxPixels) this.future.push(current);
    else current.dispose();
    this.enforceBudget();
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (!next) {
      current.dispose();
      return null;
    }
    if (current.pixelCost <= this.maxPixels) this.past.push(current);
    else current.dispose();
    this.enforceBudget();
    return next;
  }

  clear() {
    this.disposeEntries(this.past);
    this.disposeEntries(this.future);
  }

  private enforceBudget() {
    while (this.past.length > this.maxEntries) this.past.shift()?.dispose();
    while (this.future.length > this.maxEntries) this.future.shift()?.dispose();
    let pixels = 0;
    for (const entry of this.past) pixels += entry.pixelCost;
    for (const entry of this.future) pixels += entry.pixelCost;
    while (pixels > this.maxPixels && this.past.length + this.future.length > 1) {
      const entry = this.past.length > 1 ? this.past.shift() : this.future.shift();
      if (!entry) break;
      pixels -= entry.pixelCost;
      entry.dispose();
    }
  }

  private disposeEntries(entries: T[]) {
    for (const entry of entries) entry.dispose();
    entries.length = 0;
  }
}
