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

/** Geometry and material capability required by narrow-phase collision. */
export interface CollisionBody {
  readonly count: number;
  readonly wn: ArrayLike<number>;
  readonly wv: ArrayLike<number>;
  readonly restitution: number;
  readonly friction: number;
}

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

export interface Manifold<TBody extends CollisionBody = CollisionBody> {
  a: TBody;
  b: TBody;
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

export function createManifold<TBody extends CollisionBody>(a: TBody, b: TBody): Manifold<TBody> {
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

/**
 * Deepest penetration of `b` into any face of `a`. A positive result means the
 * bodies are separated along that face's normal, which is an early-out.
 *
 * The support scan (furthest vertex of `b` along the face's inward normal) is
 * inlined into the face loop: it is the profiler's hottest leaf, and hoisting
 * the vertex arrays into locals with flat indices keeps it free of repeated
 * property loads and call overhead. Same dot products, same strict-`>`
 * tie-breaks, so the chosen face and separation are bit-identical.
 */
function leastPenetration(a: CollisionBody, b: CollisionBody, out: Penetration) {
  const an = a.wn;
  const av = a.wv;
  const bv = b.wv;
  const aEnd = a.count * 2;
  const bEnd = b.count * 2;
  let bestSep = -Infinity;
  let bestFace = 0;
  for (let k = 0; k < aEnd; k += 2) {
    const nx = an[k];
    const ny = an[k + 1];
    const dx = -nx;
    const dy = -ny;
    let s = 0;
    let bestDot = bv[0] * dx + bv[1] * dy;
    for (let j = 2; j < bEnd; j += 2) {
      const d = bv[j] * dx + bv[j + 1] * dy;
      if (d > bestDot) {
        bestDot = d;
        s = j;
      }
    }
    const sep = nx * (bv[s] - av[k]) + ny * (bv[s + 1] - av[k + 1]);
    if (sep > bestSep) {
      bestSep = sep;
      bestFace = k >> 1;
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
export function collide<TBody extends CollisionBody>(
  a: TBody,
  b: TBody,
  out: Manifold<TBody>,
): boolean {
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
  const inw = inc.wn;
  const incEnd = inc.count * 2;
  let incFace = 0;
  let minDot = Infinity;
  for (let k = 0; k < incEnd; k += 2) {
    const d = inw[k] * nx + inw[k + 1] * ny;
    if (d < minDot) {
      minDot = d;
      incFace = k >> 1;
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
