/**
 * Pre-rendered sprites for every soft-edged primitive the engine draws.
 *
 * `createRadialGradient` + `addColorStop` rebuilds a gradient object from
 * scratch on every call, and each stop's colour string has to be CSS-parsed.
 * Doing that per smoke puff and six times per flame *per frame* made gradient
 * construction the single largest block of engine CPU time once a few fires
 * were burning.
 *
 * So every gradient is baked once into a small offscreen canvas at full
 * opacity and drawn with `drawImage` + `globalAlpha` — a texture blit with a
 * numeric alpha, no allocation and no colour parsing. Per-draw alpha is
 * factored out of the gradient stops: a stop that used to be `alpha * 0.5`
 * becomes a constant `0.5` in the sprite, with `alpha` applied via
 * `globalAlpha`, which reproduces the original colours exactly.
 *
 * Sprites are built lazily on first use (they need a DOM) and shared process-
 * wide; the whole set is a few hundred KB.
 */

type Stop = readonly [offset: number, color: string];

/** Bake a radial gradient into a `radius * 2` square canvas. */
function radial(radius: number, stops: readonly Stop[]): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const size = radius * 2;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  ctx.fillStyle = g;
  // The gradient is fully transparent past `radius`, so a rect fill is both
  // cheaper than an arc and produces identical pixels.
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/**
 * A horizontal streak: bright along its length, feathered to nothing at both
 * ends and both edges. Drawn stretched and rotated for tracers, motion trails
 * and the water hose's pressurized stream, so it is baked once at a generous
 * size and scaled down rather than per-effect.
 */
function streak(length: number, thickness: number, color: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = length;
  canvas.height = thickness;
  const ctx = canvas.getContext("2d")!;
  const along = ctx.createLinearGradient(0, 0, length, 0);
  along.addColorStop(0, "rgba(255,255,255,0)");
  along.addColorStop(0.35, color);
  along.addColorStop(0.75, color);
  along.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, length, thickness);
  // Feather the edges perpendicular to the streak so it reads as a glowing
  // filament rather than a hard-edged bar.
  const across = ctx.createLinearGradient(0, 0, 0, thickness);
  across.addColorStop(0, "rgba(0,0,0,0)");
  across.addColorStop(0.5, "rgba(0,0,0,1)");
  across.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, length, thickness);
  return canvas;
}

/** Four-point twinkle: soft core plus tapered spikes. */
function twinkle(radius: number): HTMLCanvasElement {
  const canvas = radial(radius, [
    [0, "rgba(255, 255, 255, 1)"],
    [0.35, "rgba(220, 240, 255, 0.5)"],
    [1, "rgba(180, 220, 255, 0)"],
  ]);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.translate(radius, radius);
  for (let i = 0; i < 4; i++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -radius);
    ctx.lineTo(radius * 0.13, 0);
    ctx.lineTo(0, radius * 0.2);
    ctx.lineTo(-radius * 0.13, 0);
    ctx.fill();
  }
  return canvas;
}

/**
 * One vertically coherent flame body, baked from three nested tongues.
 *
 * Earlier fire assembled its body from up to five overlapping radial sprites
 * every frame. Besides the draw-call cost, the overlaps read as a stack of
 * glowing beads. Baking the silhouette once gives the flame one continuous
 * edge and lets animation come from cheap scale/sway at draw time.
 */
function flameBody(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  const tongue = (
    points: readonly [number, number, number, number, number, number, number, number],
    stops: readonly Stop[],
    glow: string,
    blur: number,
  ) => {
    const [tipX, tipY, leftX, shoulderY, baseLeft, baseY, baseRight, curlX] = points;
    const gradient = ctx.createLinearGradient(0, tipY, 0, baseY);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.shadowColor = glow;
    ctx.shadowBlur = blur;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.bezierCurveTo(leftX, shoulderY, baseLeft, baseY * 0.68, baseLeft, baseY);
    ctx.quadraticCurveTo((baseLeft + baseRight) / 2, baseY + 8, baseRight, baseY);
    ctx.bezierCurveTo(baseRight, baseY * 0.66, curlX, shoulderY * 0.82, tipX, tipY);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  ctx.globalCompositeOperation = "lighter";
  tongue(
    [76, 15, 34, 86, 22, 229, 140, 124],
    [
      [0, "rgba(255, 88, 18, 0)"],
      [0.16, "rgba(255, 104, 22, 0.72)"],
      [0.58, "rgba(255, 128, 24, 0.92)"],
      [1, "rgba(255, 82, 12, 0.32)"],
    ],
    "rgba(255, 92, 18, 0.9)",
    13,
  );
  tongue(
    [103, 54, 61, 112, 50, 232, 130, 132],
    [
      [0, "rgba(255, 176, 42, 0)"],
      [0.2, "rgba(255, 182, 48, 0.9)"],
      [0.7, "rgba(255, 210, 82, 0.96)"],
      [1, "rgba(255, 160, 32, 0.48)"],
    ],
    "rgba(255, 166, 36, 0.85)",
    8,
  );
  tongue(
    [74, 103, 56, 145, 62, 232, 109, 104],
    [
      [0, "rgba(255, 232, 154, 0)"],
      [0.28, "rgba(255, 232, 154, 0.92)"],
      [0.76, "rgba(255, 248, 216, 1)"],
      [1, "rgba(255, 212, 112, 0.72)"],
    ],
    "rgba(255, 226, 132, 0.8)",
    5,
  );
  return canvas;
}

export interface Sprites {
  /** Fire + effects (drawn additively). */
  smoke: HTMLCanvasElement;
  /** Fire-lit smoke, used for the first moments of a puff's life. */
  smokeWarm: HTMLCanvasElement;
  steam: HTMLCanvasElement;
  glow: HTMLCanvasElement;
  flameLow: HTMLCanvasElement;
  flameHigh: HTMLCanvasElement;
  flameCore: HTMLCanvasElement;
  /** Coherent multi-tone flame silhouette, anchored at its lower edge. */
  flameBody: HTMLCanvasElement;
  flash: HTMLCanvasElement;
  /** White-hot impact pop, brighter and tighter than the muzzle `flash`. */
  flashWhite: HTMLCanvasElement;
  emberHot: HTMLCanvasElement;
  emberCool: HTMLCanvasElement;
  /** The last stage of an ember's life: dull red, barely holding its glow. */
  emberDark: HTMLCanvasElement;
  spark: HTMLCanvasElement;
  /**
   * Hollow rings. The transparent core matters: these ride *over* holes, and a
   * ring that painted its own centre would fill the void back in.
   */
  shockRing: HTMLCanvasElement;
  heatRing: HTMLCanvasElement;
  /** Stretched/rotated filaments: tracers, motion trails, water stream. */
  streakHot: HTMLCanvasElement;
  streakWater: HTMLCanvasElement;
  /** Pale, drifting page dust (plaster, sawdust haze, broom sweep). */
  dust: HTMLCanvasElement;
  mist: HTMLCanvasElement;
  sparkle: HTMLCanvasElement;
  /** Opaque core of a singularity — it occludes, so it is drawn normally. */
  singularity: HTMLCanvasElement;
  /** Hot violet/amber accretion band around a black hole (hollow, like heatRing). */
  accretion: HTMLCanvasElement;
  /** Persistent damage. */
  char: HTMLCanvasElement;
  scorch: HTMLCanvasElement;
  dent: HTMLCanvasElement;
  bulletCore: HTMLCanvasElement;
  /** Alpha mask used with `destination-out` to erase damage. */
  erase: HTMLCanvasElement;
}

let cache: Sprites | null = null;

/**
 * Release the baked sprite set (a few hundred KB of canvas backing store).
 *
 * Always safe: the cache is rebuilt lazily by the next `sprites()` call, so
 * callers holding no reference lose nothing but the memory. The engine invokes
 * this when the last live `DestroyerEngine` is disposed; hosts that mount and
 * unmount rapidly pay one rebuild per remount, which is a handful of small
 * gradient fills.
 */
export function clearSpriteCache() {
  cache = null;
}

export function sprites(): Sprites {
  return (cache ??= {
    smoke: radial(96, [
      [0, "rgba(70, 66, 64, 1)"],
      [0.55, "rgba(58, 54, 52, 0.62)"],
      [1, "rgba(52, 48, 46, 0)"],
    ]),
    smokeWarm: radial(96, [
      [0, "rgba(120, 92, 66, 1)"],
      [0.55, "rgba(92, 70, 54, 0.62)"],
      [1, "rgba(70, 56, 46, 0)"],
    ]),
    steam: radial(96, [
      [0, "rgba(235, 240, 245, 1)"],
      [1, "rgba(235, 240, 245, 0)"],
    ]),
    glow: radial(96, [
      [0, "rgba(255, 120, 30, 1)"],
      [1, "rgba(255, 80, 20, 0)"],
    ]),
    flameLow: radial(96, [
      [0, "rgba(255, 180, 60, 1)"],
      [1, "rgba(255, 90, 20, 0)"],
    ]),
    flameHigh: radial(96, [
      [0, "rgba(255, 220, 120, 1)"],
      [1, "rgba(255, 140, 40, 0)"],
    ]),
    flameCore: radial(64, [
      [0, "rgba(255, 250, 220, 1)"],
      [1, "rgba(255, 200, 90, 0)"],
    ]),
    flameBody: flameBody(),
    // Stops carry the muzzle flash's original 0.9 : 0.5 : 0 alpha ratio.
    flash: radial(96, [
      [0, "rgba(255, 240, 180, 1)"],
      [0.5, "rgba(255, 160, 60, 0.556)"],
      [1, "rgba(255, 120, 30, 0)"],
    ]),
    emberHot: radial(32, [
      [0, "rgba(255, 220, 90, 1)"],
      [0.5, "rgba(255, 180, 55, 0.9)"],
      [1, "rgba(255, 130, 25, 0)"],
    ]),
    emberCool: radial(32, [
      [0, "rgba(255, 150, 50, 1)"],
      [0.5, "rgba(255, 115, 32, 0.9)"],
      [1, "rgba(210, 75, 15, 0)"],
    ]),
    emberDark: radial(32, [
      [0, "rgba(205, 72, 26, 1)"],
      [0.5, "rgba(150, 46, 16, 0.85)"],
      [1, "rgba(88, 26, 10, 0)"],
    ]),
    spark: radial(32, [
      [0, "rgba(255, 245, 200, 1)"],
      [0.5, "rgba(255, 230, 150, 0.9)"],
      [1, "rgba(255, 210, 110, 0)"],
    ]),
    flashWhite: radial(96, [
      [0, "rgba(255, 255, 255, 1)"],
      [0.28, "rgba(255, 248, 225, 0.75)"],
      [0.62, "rgba(255, 205, 130, 0.22)"],
      [1, "rgba(255, 170, 90, 0)"],
    ]),
    shockRing: radial(96, [
      [0, "rgba(255, 255, 255, 0)"],
      [0.72, "rgba(255, 255, 255, 0)"],
      [0.87, "rgba(255, 252, 240, 1)"],
      [0.97, "rgba(255, 220, 170, 0.28)"],
      [1, "rgba(255, 200, 140, 0)"],
    ]),
    // A wide, soft band rather than a thin one: a tight ring reads as a bubble
    // outline, a broad one reads as heat bleeding out of a burnt edge.
    heatRing: radial(96, [
      [0, "rgba(255, 120, 30, 0)"],
      [0.3, "rgba(255, 120, 30, 0)"],
      [0.62, "rgba(255, 140, 40, 0.45)"],
      [0.82, "rgba(255, 96, 20, 0.9)"],
      [1, "rgba(190, 45, 8, 0)"],
    ]),
    streakHot: streak(160, 24, "rgba(255, 236, 190, 1)"),
    streakWater: streak(160, 24, "rgba(190, 224, 255, 1)"),
    dust: radial(96, [
      [0, "rgba(214, 206, 194, 1)"],
      [0.5, "rgba(198, 190, 178, 0.55)"],
      [1, "rgba(186, 178, 166, 0)"],
    ]),
    mist: radial(96, [
      [0, "rgba(226, 240, 255, 1)"],
      [0.5, "rgba(198, 222, 248, 0.5)"],
      [1, "rgba(180, 210, 245, 0)"],
    ]),
    sparkle: twinkle(24),
    // Hard-edged at the horizon and only feathered over the last few percent:
    // a black hole's edge is the one part of it that is genuinely sharp.
    singularity: radial(96, [
      [0, "rgba(0, 0, 0, 1)"],
      [0.86, "rgba(0, 0, 0, 1)"],
      [0.94, "rgba(6, 2, 12, 0.75)"],
      [1, "rgba(10, 4, 18, 0)"],
    ]),
    accretion: radial(96, [
      [0, "rgba(150, 60, 255, 0)"],
      [0.62, "rgba(150, 60, 255, 0)"],
      [0.79, "rgba(196, 108, 255, 0.55)"],
      [0.89, "rgba(255, 168, 90, 1)"],
      [0.96, "rgba(255, 236, 200, 0.5)"],
      [1, "rgba(255, 200, 140, 0)"],
    ]),
    char: radial(96, [
      [0, "rgba(15, 9, 5, 1)"],
      [0.6, "rgba(25, 14, 7, 0.5)"],
      [1, "rgba(25, 14, 7, 0)"],
    ]),
    scorch: radial(96, [
      [0, "rgba(12, 8, 5, 1)"],
      [0.55, "rgba(25, 15, 8, 0.55)"],
      [1, "rgba(25, 15, 8, 0)"],
    ]),
    dent: radial(64, [
      [0, "rgba(30, 28, 26, 1)"],
      [1, "rgba(30, 28, 26, 0)"],
    ]),
    bulletCore: radial(48, [
      [0, "rgba(8, 6, 5, 1)"],
      [0.7, "rgba(15, 12, 10, 0.918)"],
      [1, "rgba(15, 12, 10, 0)"],
    ]),
    erase: radial(96, [
      [0, "rgba(0, 0, 0, 1)"],
      [0.7, "rgba(0, 0, 0, 0.9)"],
      [1, "rgba(0, 0, 0, 0)"],
    ]),
  });
}

/**
 * Draw `sprite` centred on (x, y) at `radius`, at `alpha`.
 *
 * Leaves `globalAlpha` set — callers reset it once per pass rather than per
 * draw. Sub-perceptual and degenerate draws are skipped outright.
 */
export function blit(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  x: number,
  y: number,
  radius: number,
  alpha: number,
) {
  if (alpha <= 0.004 || radius <= 0.3) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
}

/**
 * `blit` with independent half-width and half-height.
 *
 * Every sprite is baked as a circle, and scaling one anisotropically turns it
 * into an ellipse for free — which is the whole difference between a fire that
 * looks like a stack of balls and one that licks upward.
 */
export function blitRect(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  x: number,
  y: number,
  halfWidth: number,
  halfHeight: number,
  alpha: number,
) {
  if (alpha <= 0.004 || halfWidth <= 0.3 || halfHeight <= 0.3) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(sprite, x - halfWidth, y - halfHeight, halfWidth * 2, halfHeight * 2);
}

/**
 * Draw a streak sprite as a filament running from (x, y) along `angle`.
 *
 * Unlike `blit` this needs a rotation, and the fx canvas already carries a
 * dpr + scroll transform that must not be clobbered — hence save/restore. Only
 * a handful of streaks are alive at once, so the state push is affordable here
 * in a way it would not be for embers.
 */
export function blitStreak(
  ctx: CanvasRenderingContext2D,
  sprite: HTMLCanvasElement,
  x: number,
  y: number,
  angle: number,
  length: number,
  thickness: number,
  alpha: number,
) {
  // A negative length trails the streak *backwards* from (x, y) — how motion
  // trails are drawn, since they hang behind whatever is moving.
  if (alpha <= 0.004 || Math.abs(length) <= 1) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.drawImage(sprite, 0, -thickness / 2, length, thickness);
  ctx.restore();
}
