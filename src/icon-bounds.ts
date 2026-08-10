import type { ToolArtFn } from "./types";

export type ToolIconBounds = readonly [x0: number, y0: number, x1: number, y1: number];

const bounds = new Map<ToolArtFn, ToolIconBounds>();

/** Register measured 256px-bake bounds for readback-free, unclipped toolbar icons. */
export function registerToolIconBounds(art: ToolArtFn, value: ToolIconBounds): ToolArtFn {
  bounds.set(art, value);
  return art;
}

export function toolIconBounds(art: ToolArtFn): ToolIconBounds | undefined {
  return bounds.get(art);
}
