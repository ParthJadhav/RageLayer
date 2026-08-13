export type InteractionKind =
  | "impact"
  | "fire"
  | "water"
  | "electricity"
  | "acid"
  | "laser"
  | "gravity"
  | "explosion";

export type ComboId = "steam-shock" | "conductive-surge" | "volatile-corrosion" | "orbital-bomb";

export interface ComboEvent {
  id: ComboId;
  first: InteractionKind;
  second: InteractionKind;
  x: number;
  y: number;
  timestamp: number;
}

interface Interaction {
  kind: InteractionKind;
  x: number;
  y: number;
  timestamp: number;
}

interface ComboDefinition {
  id: ComboId;
  a: InteractionKind;
  b: InteractionKind;
}

export const COMBO_DEFINITIONS: readonly ComboDefinition[] = [
  { id: "steam-shock", a: "fire", b: "water" },
  { id: "conductive-surge", a: "water", b: "electricity" },
  { id: "volatile-corrosion", a: "acid", b: "fire" },
  { id: "orbital-bomb", a: "gravity", b: "explosion" },
];

export interface ComboTrackerOptions {
  windowMs?: number;
  radius?: number;
  cooldownMs?: number;
  maxInteractions?: number;
}

/** Allocation-light, spatially bounded detector for cross-tool interactions. */
export class ComboTracker {
  private readonly interactions: Interaction[] = [];
  private readonly cooldowns = new Map<string, number>();
  private readonly windowMs: number;
  private readonly radiusSquared: number;
  private readonly cooldownMs: number;
  private readonly maxInteractions: number;

  constructor(options: ComboTrackerOptions = {}) {
    this.windowMs = Math.max(100, options.windowMs ?? 1_500);
    const radius = Math.max(8, options.radius ?? 84);
    this.radiusSquared = radius * radius;
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 700);
    this.maxInteractions = Math.max(8, options.maxInteractions ?? 64);
  }

  record(kind: InteractionKind, x: number, y: number, timestamp = performance.now()): ComboEvent[] {
    this.prune(timestamp);
    const matches: ComboEvent[] = [];
    for (let i = this.interactions.length - 1; i >= 0; i--) {
      const previous = this.interactions[i];
      const definition = COMBO_DEFINITIONS.find(
        ({ a, b }) => (a === previous.kind && b === kind) || (b === previous.kind && a === kind),
      );
      if (!definition) continue;
      const dx = previous.x - x;
      const dy = previous.y - y;
      if (dx * dx + dy * dy > this.radiusSquared) continue;
      const cell = `${definition.id}:${Math.round(x / 64)}:${Math.round(y / 64)}`;
      if ((this.cooldowns.get(cell) ?? -Infinity) + this.cooldownMs > timestamp) continue;
      this.cooldowns.set(cell, timestamp);
      matches.push({
        id: definition.id,
        first: previous.kind,
        second: kind,
        x: (previous.x + x) * 0.5,
        y: (previous.y + y) * 0.5,
        timestamp,
      });
      break;
    }
    this.interactions.push({ kind, x, y, timestamp });
    if (this.interactions.length > this.maxInteractions) this.interactions.shift();
    return matches;
  }

  clear() {
    this.interactions.length = 0;
    this.cooldowns.clear();
  }

  private prune(timestamp: number) {
    let expired = 0;
    while (
      expired < this.interactions.length &&
      timestamp - this.interactions[expired].timestamp > this.windowMs
    )
      expired++;
    if (expired > 0) this.interactions.splice(0, expired);
    for (const [key, last] of this.cooldowns) {
      if (timestamp - last > this.windowMs + this.cooldownMs) this.cooldowns.delete(key);
    }
  }
}
