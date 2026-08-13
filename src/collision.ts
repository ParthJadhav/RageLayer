/**
 * Contact generation for the rigid-body solver: SAT plus face clipping.
 *
 * Kept apart from `physics.ts` because it answers a self-contained geometric
 * question — do these two convex polygons overlap, and where do they touch? —
 * with no notion of time, forces or the world. The pipeline is Box2D-lite's:
 * SAT both ways for the axis of least penetration, pick the reference and
 * incident faces from it, clip the incident face against the reference face's
 * side planes, keep the points behind the reference face.
 *
 * Everything is pooled or module-scoped scratch: a heap of a hundred tumbling
 * chunks generates contacts every frame and must not allocate to do it.
 */

import type { Body } from "./physics";

export interface ContactPoint {
  px: number;
  py: number;
  /** Penetration (negative = overlapping). */
  sep: number;
  /** Accumulated normal/tangent impulse, warm-started across iterations. */
  pn: number;
  pt: number;
  /** Effective mass along the normal and tangent. */
  mn: number;
  mt: number;
  /** Restitution target velocity, captured before any impulse is applied. */
  bias: number;
}

export interface Manifold {
  a: Body;
  b: Body;
  nx: number;
  ny: number;
  points: ContactPoint[];
  pointCount: number;
  restitution: number;
  friction: number;
}

interface Penetration {
  sep: number;
  face: number;
}

const penetrationA: Penetration = { sep: 0, face: 0 };
const penetrationB: Penetration = { sep: 0, face: 0 };

export function createContactPoint(): ContactPoint {
  return { px: 0, py: 0, sep: 0, pn: 0, pt: 0, mn: 0, mt: 0, bias: 0 };
}

export function createManifold(a: Body, b: Body): Manifold {
  return {
    a,
    b,
    nx: 0,
    ny: 0,
    points: [createContactPoint(), createContactPoint()],
    pointCount: 0,
    restitution: 0,
    friction: 0,
  };
}

/** Support point of `b` furthest along (dx, dy). */
function support(b: Body, dx: number, dy: number): number {
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < b.count; i++) {
    const d = b.wv[i * 2] * dx + b.wv[i * 2 + 1] * dy;
    if (d > bestDot) {
      bestDot = d;
      best = i;
    }
  }
  return best;
}

/**
 * Deepest penetration of `b` into any face of `a`. A positive result means the
 * bodies are separated along that face's normal, which is an early-out.
 */
function leastPenetration(a: Body, b: Body, out: Penetration) {
  let bestSep = -Infinity;
  let bestFace = 0;
  for (let i = 0; i < a.count; i++) {
    const nx = a.wn[i * 2];
    const ny = a.wn[i * 2 + 1];
    const s = support(b, -nx, -ny);
    const sep = nx * (b.wv[s * 2] - a.wv[i * 2]) + ny * (b.wv[s * 2 + 1] - a.wv[i * 2 + 1]);
    if (sep > bestSep) {
      bestSep = sep;
      bestFace = i;
    }
    if (sep > 0) break;
  }
  out.sep = bestSep;
  out.face = bestFace;
}

/** Clip a segment against a half-plane; returns the surviving points. */
function clipSegment(
  out: number[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  nx: number,
  ny: number,
  c: number,
) {
  const d0 = nx * x0 + ny * y0 - c;
  const d1 = nx * x1 + ny * y1 - c;
  out.length = 0;
  if (d0 <= 0) out.push(x0, y0);
  if (d1 <= 0) out.push(x1, y1);
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
  }
  return out;
}

const clipA: number[] = [];
const clipB: number[] = [];

/**
 * Build the contact manifold for a colliding pair, or null if they are apart.
 *
 * Reference face comes from whichever body penetrates less; the incident face
 * is the most anti-parallel face on the other body. Clipping the incident face
 * to the reference face's side planes gives the one or two contact points that
 * a stable stack needs (a single point would let every chunk see-saw).
 */
export function collide(a: Body, b: Body, out: Manifold): boolean {
  leastPenetration(a, b, penetrationA);
  if (penetrationA.sep > 0) return false;
  leastPenetration(b, a, penetrationB);
  if (penetrationB.sep > 0) return false;

  // Prefer A's face unless B's is clearly better, so the reference choice does
  // not flicker between frames on near-ties (which would reset warm starting).
  let ref = a;
  let inc = b;
  let refFace = penetrationA.face;
  let flip = false;
  if (penetrationB.sep > penetrationA.sep + 0.12) {
    ref = b;
    inc = a;
    refFace = penetrationB.face;
    flip = true;
  }

  const nx = ref.wn[refFace * 2];
  const ny = ref.wn[refFace * 2 + 1];

  // Incident face: the one on `inc` most opposed to the reference normal.
  let incFace = 0;
  let minDot = Infinity;
  for (let i = 0; i < inc.count; i++) {
    const d = inc.wn[i * 2] * nx + inc.wn[i * 2 + 1] * ny;
    if (d < minDot) {
      minDot = d;
      incFace = i;
    }
  }
  const i0 = incFace;
  const i1 = (incFace + 1) % inc.count;
  let ix0 = inc.wv[i0 * 2];
  let iy0 = inc.wv[i0 * 2 + 1];
  let ix1 = inc.wv[i1 * 2];
  let iy1 = inc.wv[i1 * 2 + 1];

  const r0 = refFace;
  const r1 = (refFace + 1) % ref.count;
  const rx0 = ref.wv[r0 * 2];
  const ry0 = ref.wv[r0 * 2 + 1];
  const rx1 = ref.wv[r1 * 2];
  const ry1 = ref.wv[r1 * 2 + 1];
  const tx = rx1 - rx0;
  const ty = ry1 - ry0;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;

  // Side planes of the reference face.
  let clipped = clipSegment(clipA, ix0, iy0, ix1, iy1, -ux, -uy, -(ux * rx0 + uy * ry0));
  if (clipped.length < 4) return false;
  ix0 = clipped[0];
  iy0 = clipped[1];
  ix1 = clipped[2];
  iy1 = clipped[3];
  clipped = clipSegment(clipB, ix0, iy0, ix1, iy1, ux, uy, ux * rx1 + uy * ry1);
  if (clipped.length < 4) return false;

  const c = nx * rx0 + ny * ry0;
  let pointCount = 0;
  for (let i = 0; i < 2; i++) {
    const px = clipped[i * 2];
    const py = clipped[i * 2 + 1];
    const sep = nx * px + ny * py - c;
    if (sep <= 0) {
      const point = out.points[pointCount++];
      point.px = px;
      point.py = py;
      point.sep = sep;
      point.pn = point.pt = point.mn = point.mt = point.bias = 0;
    }
  }
  if (pointCount === 0) return false;

  out.a = a;
  out.b = b;
  // The manifold normal always points from `a` toward `b`.
  out.nx = flip ? -nx : nx;
  out.ny = flip ? -ny : ny;
  out.pointCount = pointCount;
  out.restitution = Math.max(a.restitution, b.restitution);
  out.friction = Math.sqrt(a.friction * b.friction);
  return true;
}
