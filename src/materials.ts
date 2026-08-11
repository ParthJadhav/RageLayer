import { clamp01 } from "./math";

export const RAGEKIT_MATERIAL_ATTR = "data-ragekit-material";

export type BuiltInMaterialId = "paper" | "glass" | "metal" | "wood" | "stone" | "rubber" | "ice";

export interface MaterialDefinition {
  readonly id: string;
  readonly label: string;
  /** Resistance to holes/cuts. 1 is ordinary page material; larger is tougher. */
  readonly toughness: number;
  /** Relative rigid-body mass. */
  readonly density: number;
  /** 0..1 chance/strength of accepting fire. */
  readonly flammability: number;
  /** 0..1 response to lightning and electrical combos. */
  readonly conductivity: number;
  /** 0..1 resistance to acid erosion. */
  readonly corrosionResistance: number;
  /** 0..1 bounciness used by material-aware tools. */
  readonly restitution: number;
  /** Debris/effect tint. */
  readonly color: string;
}

export const BUILT_IN_MATERIALS: Readonly<Record<BuiltInMaterialId, MaterialDefinition>> = {
  paper: {
    id: "paper",
    label: "Paper",
    toughness: 1,
    density: 1,
    flammability: 1,
    conductivity: 0.05,
    corrosionResistance: 0.15,
    restitution: 0.12,
    color: "#d8d2c8",
  },
  glass: {
    id: "glass",
    label: "Glass",
    toughness: 0.65,
    density: 1.35,
    flammability: 0,
    conductivity: 0.08,
    corrosionResistance: 0.75,
    restitution: 0.08,
    color: "#bde8f2",
  },
  metal: {
    id: "metal",
    label: "Metal",
    toughness: 2.5,
    density: 2.8,
    flammability: 0,
    conductivity: 1,
    corrosionResistance: 0.65,
    restitution: 0.18,
    color: "#9aa4af",
  },
  wood: {
    id: "wood",
    label: "Wood",
    toughness: 1.35,
    density: 1.25,
    flammability: 1,
    conductivity: 0.03,
    corrosionResistance: 0.3,
    restitution: 0.1,
    color: "#9b6a38",
  },
  stone: {
    id: "stone",
    label: "Stone",
    toughness: 3.2,
    density: 3.4,
    flammability: 0,
    conductivity: 0.02,
    corrosionResistance: 0.82,
    restitution: 0.04,
    color: "#8e8880",
  },
  rubber: {
    id: "rubber",
    label: "Rubber",
    toughness: 1.7,
    density: 0.9,
    flammability: 0.45,
    conductivity: 0,
    corrosionResistance: 0.7,
    restitution: 0.82,
    color: "#333238",
  },
  ice: {
    id: "ice",
    label: "Ice",
    toughness: 0.55,
    density: 0.92,
    flammability: 0,
    conductivity: 0.35,
    corrosionResistance: 0.9,
    restitution: 0.04,
    color: "#c8efff",
  },
};

export interface MaterialRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  depth: number;
  material: MaterialDefinition;
}

/** Registry + document-space lookup for `[data-ragekit-material]` regions. */
export class MaterialSystem {
  private readonly definitions = new Map<string, MaterialDefinition>();
  private regions: MaterialRegion[] = [];

  constructor(definitions: Iterable<MaterialDefinition> = Object.values(BUILT_IN_MATERIALS)) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: MaterialDefinition): this {
    if (!definition.id.trim()) throw new TypeError("Material id must not be empty");
    this.definitions.set(
      definition.id,
      Object.freeze({
        ...definition,
        toughness: Math.max(0.05, definition.toughness),
        density: Math.max(0.05, definition.density),
        flammability: clamp01(definition.flammability),
        conductivity: clamp01(definition.conductivity),
        corrosionResistance: clamp01(definition.corrosionResistance),
        restitution: clamp01(definition.restitution),
      }),
    );
    return this;
  }

  get(id: string): MaterialDefinition | undefined {
    return this.definitions.get(id);
  }

  all(): MaterialDefinition[] {
    return [...this.definitions.values()];
  }

  /** Measure marked elements before the host DOM is hidden behind the capture. */
  scan(root: HTMLElement, scrollX = window.scrollX, scrollY = window.scrollY) {
    const elements: Element[] = [];
    if (root.hasAttribute(RAGEKIT_MATERIAL_ATTR)) elements.push(root);
    elements.push(...root.querySelectorAll(`[${RAGEKIT_MATERIAL_ATTR}]`));
    const regions: MaterialRegion[] = [];
    for (const element of elements) {
      const id = element.getAttribute(RAGEKIT_MATERIAL_ATTR)?.trim();
      const material = id ? this.definitions.get(id) : undefined;
      if (!material) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      let depth = 0;
      for (
        let parent = element.parentElement;
        parent && parent !== root;
        parent = parent.parentElement
      )
        depth++;
      regions.push({
        x0: rect.left + scrollX,
        y0: rect.top + scrollY,
        x1: rect.right + scrollX,
        y1: rect.bottom + scrollY,
        depth,
        material,
      });
    }
    // Most specific/deepest region wins during the reverse lookup below.
    regions.sort((a, b) => a.depth - b.depth);
    this.regions = regions;
  }

  at(x: number, y: number): MaterialDefinition {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region = this.regions[i];
      if (x >= region.x0 && x <= region.x1 && y >= region.y0 && y <= region.y1)
        return region.material;
    }
    return this.definitions.get("paper") ?? BUILT_IN_MATERIALS.paper;
  }

  clearRegions() {
    this.regions = [];
  }
}
