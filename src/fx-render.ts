/**
 * Drawing for the effects layer: particles, flames, and the singularity.
 *
 * Everything here is pure paint, so `DestroyerEngine.render` is left as a
 * short script of what is drawn in which order and why — in particular where
 * the void mask cuts the frame in half — while the "how" lives down here.
 *
 * Particles are classified once per frame into four buckets, because each pass
 * needs a different blend mode and a different z-order against that mask:
 * `wet` (water, drawn *on* the page), `puff` (smoke, steam, dust), `bit`
 * (solid debris and shards), and `hot` (everything additive). The buckets are
 * fields rather than locals so the render path allocates nothing per frame.
 */

import { TAU } from "./math";
import { blit, blitRect, blitStreak, sprites } from "./sprites";
import type { Flame, Particle, Singularity } from "./types";

/** The document band the fx canvas currently covers. */
export interface FxView {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class FxPainter {
  /** Per-frame render buckets, reused to keep the render path allocation-free. */
  private readonly wet: Particle[] = [];
  private readonly puff: Particle[] = [];
  private readonly bit: Particle[] = [];
  private readonly hot: Particle[] = [];

  /** Drop every retained reference (the engine is going away). */
  clear() {
    this.wet.length = this.puff.length = this.bit.length = this.hot.length = 0;
  }

  /** True when the last `classify` found particles that draw onto the page. */
  get hasSurfaceParticles(): boolean {
    return this.wet.length > 0;
  }

  /** Sort the visible particles into the four passes below. */
  classify(particles: readonly Particle[], view: FxView) {
    // One classification pass. Particles live in document space and the page
    // can be far taller than the screen, so anything outside the fx band is
    // dropped here instead of being submitted and clipped by the canvas.
    const { wet, puff, bit, hot } = this;
    wet.length = puff.length = bit.length = hot.length = 0;
    for (const p of particles) {
      if (p.x < view.left - 200 || p.x > view.right + 200) continue;
      if (p.y < view.top - 200 || p.y > view.bottom + 200) continue;
      switch (p.kind) {
        case "wet":
        case "splash":
        case "water":
        case "rivulet":
        case "stream":
          wet.push(p);
          break;
        case "smoke":
        case "steam":
        case "dust":
          puff.push(p);
          break;
        case "debris":
        case "casing":
        case "sawdust":
        case "shard":
        case "paint":
        case "ice":
          bit.push(p);
          break;
        case "ember":
        case "spark":
        case "flash":
        case "ring":
        case "streak":
        case "jet":
        case "sparkle":
        case "spaghetti":
          hot.push(p);
          break;
      }
    }
  }

  /**
   * Water, splashes and damp patches. Surface-bound, so this draws before the
   * void mask. Wet patches are a soft sheen rather than a filled ellipse — a
   * hard-edged blob reads as a grey stain on a dark page, where a feathered one
   * reads as a surface that is damp.
   */
  drawWet(ctx: CanvasRenderingContext2D) {
    const sprite = sprites();
    for (const p of this.wet) {
      if (p.kind !== "wet") continue;
      const t = p.life / p.maxLife;
      blitRect(ctx, sprite.mist, p.x, p.y, p.size * 1.5, p.size * 0.95, 0.16 * (1 - t));
    }
    ctx.globalAlpha = 1;
    for (const p of this.wet) {
      if (p.kind === "wet") continue;
      const t = p.life / p.maxLife;
      if (p.kind === "stream") {
        // The unbroken column of water leaving the nozzle, before it fans out
        // into droplets. Drawn opaque, not additively — water occludes.
        blitStreak(
          ctx,
          sprite.streakWater,
          p.x,
          p.y,
          p.angle ?? 0,
          p.len ?? 40,
          p.size,
          0.85 * (1 - t * 0.6),
        );
        continue;
      }
      if (p.kind === "rivulet") {
        // A run of water sliding down the page: a fading tail behind a bead.
        blitStreak(
          ctx,
          sprite.streakWater,
          p.x,
          p.y,
          Math.PI / 2,
          -(p.len ?? 0),
          p.size * 2.4,
          0.5 * (1 - t),
        );
        ctx.fillStyle = "rgb(150, 195, 240)";
        ctx.globalAlpha = 0.75 * (1 - t);
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size * 0.8, p.size * 1.15, 0, 0, TAU);
        ctx.fill();
        continue;
      }
      ctx.fillStyle = p.kind === "water" ? "rgb(140, 190, 240)" : "rgb(160, 200, 240)";
      ctx.globalAlpha = p.kind === "water" ? 0.85 : 0.7 * (1 - t);
      ctx.beginPath();
      ctx.ellipse(
        p.x,
        p.y,
        p.size * 0.7,
        p.size * 1.3,
        Math.atan2(p.vy, p.vx) + Math.PI / 2,
        0,
        TAU,
      );
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Smoke, steam and dust: normal blending, soft grey/white. */
  drawPuffs(ctx: CanvasRenderingContext2D, time: number) {
    const sprite = sprites();
    for (const p of this.puff) {
      const t = p.life / p.maxLife;
      if (p.kind === "dust") {
        blit(
          ctx,
          sprite.dust,
          p.x,
          p.y,
          p.size * (1 + t * 2.6),
          0.3 * (1 - t) * Math.min(1, t * 8),
        );
        continue;
      }
      if (p.kind === "steam") {
        blit(
          ctx,
          sprite.steam,
          p.x,
          p.y,
          p.size * (1 + t * 2.2),
          0.32 * (1 - t) * Math.min(1, t * 6),
        );
        continue;
      }
      // Smoke: born lit by the fire it came off, cooling to grey as it climbs,
      // and swaying so a column rolls rather than sliding straight up. Two
      // incommensurate frequencies — the second keyed off the puff's height so
      // neighbours shear against each other — give the slow sway a turbulent
      // curl for the cost of one extra sin, no per-frame state.
      const ph = p.phase ?? 0;
      const sway =
        (Math.sin(time * 1.6 + ph) + 0.55 * Math.sin(time * 3.9 + ph * 1.7 + p.y * 0.013)) *
        p.size *
        0.45 *
        t;
      const fade = (1 - t) * Math.min(1, t * 5);
      if (t < 0.35)
        blit(
          ctx,
          sprite.smokeWarm,
          p.x + sway,
          p.y,
          p.size * (1 + t * 2.4),
          0.34 * fade * (1 - t / 0.35),
        );
      blit(ctx, sprite.smoke, p.x + sway, p.y, p.size * (1 + t * 2.6), 0.3 * fade);
    }
    ctx.globalAlpha = 1;
  }

  /** Debris, casings, sawdust, paint drips, and flying page shards. */
  drawSolids(ctx: CanvasRenderingContext2D) {
    for (const p of this.bit) {
      const t = p.life / p.maxLife;
      if (p.kind === "paint") {
        // The wet head of a drip; the run it leaves behind is stamped on death.
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = p.color ?? "#e63946";
        ctx.beginPath();
        ctx.ellipse(
          p.x,
          p.y - (p.len ?? 0) * 0.5,
          p.size * 0.5,
          p.size * 0.5 + (p.len ?? 0) * 0.5,
          0,
          0,
          TAU,
        );
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.85, 0, TAU);
        ctx.fill();
        continue;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle ?? 0);
      ctx.globalAlpha = 1 - t * t;
      if (p.kind === "ice") {
        // A splinter of frozen page: a pale facet with one lit edge. Triangular
        // rather than square, because ice breaks along planes.
        ctx.fillStyle = "rgba(206, 238, 255, 0.9)";
        ctx.beginPath();
        ctx.moveTo(0, -p.size);
        ctx.lineTo(p.size * 0.8, p.size * 0.7);
        ctx.lineTo(-p.size * 0.7, p.size * 0.6);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      } else if (p.kind === "shard" && p.img) {
        // A torn-off chunk of the real page tumbling through the air. The ghost
        // behind it is a cheap motion blur — one extra blit, no filter.
        const speed = Math.abs(p.vx) + Math.abs(p.vy);
        if (speed > 200) {
          ctx.globalAlpha = (1 - t * t) * 0.28;
          ctx.drawImage(
            p.img,
            p.sx!,
            p.sy!,
            p.sw!,
            p.sh!,
            -p.size / 2 - p.vx * 0.012,
            -p.size / 2 - p.vy * 0.012,
            p.size,
            p.size,
          );
          ctx.globalAlpha = 1 - t * t;
        }
        ctx.drawImage(p.img, p.sx!, p.sy!, p.sw!, p.sh!, -p.size / 2, -p.size / 2, p.size, p.size);
        ctx.strokeStyle = "rgba(10, 8, 6, 0.55)";
        ctx.lineWidth = 1;
        ctx.strokeRect(-p.size / 2, -p.size / 2, p.size, p.size);
        // Lit top edge, so a tumbling shard catches the light as it spins.
        ctx.strokeStyle = "rgba(255, 252, 245, 0.4)";
        ctx.beginPath();
        ctx.moveTo(-p.size / 2, -p.size / 2);
        ctx.lineTo(p.size / 2, -p.size / 2);
        ctx.stroke();
      } else if (p.kind === "casing") {
        ctx.fillStyle = "#c9a227";
        ctx.fillRect(-p.size, -p.size * 0.4, p.size * 2, p.size * 0.8);
        ctx.fillStyle = "rgba(255, 240, 190, 0.7)";
        ctx.fillRect(-p.size, -p.size * 0.4, p.size * 2, p.size * 0.25);
      } else {
        ctx.fillStyle = p.color ?? (p.kind === "sawdust" ? "#a8865a" : "#55504b");
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      }
      ctx.restore();
    }
  }

  /** The additive pass: embers, sparks, flashes, shockwaves, infalling matter. */
  drawHot(ctx: CanvasRenderingContext2D, time: number) {
    const sprite = sprites();
    for (const p of this.hot) {
      const t = p.life / p.maxLife;
      switch (p.kind) {
        case "ember": {
          // Cooling arc: white-orange while fresh, orange in the middle of the
          // flight, dull red at the end — the way a real ember dims rather
          // than fading at one colour. Drifters (spawned with a `phase`) also
          // sway on the thermal and breathe: two cheap sins, no state.
          let ex = p.x;
          let glow = 1 - t;
          if (p.phase !== undefined) {
            ex += Math.sin(time * 2.2 + p.phase) * (3 + p.size) * t;
            glow *= 0.78 + 0.22 * Math.sin(time * 15 + p.phase);
          }
          blit(
            ctx,
            t < 0.38 ? sprite.emberHot : t < 0.72 ? sprite.emberCool : sprite.emberDark,
            ex,
            p.y,
            p.size * (1 - t * 0.5) * 1.6,
            glow,
          );
          break;
        }
        case "spark":
          // Fast sparks smear into a streak; slow ones stay points.
          if (Math.abs(p.vx) + Math.abs(p.vy) > 260) {
            blitStreak(
              ctx,
              sprite.streakHot,
              p.x,
              p.y,
              Math.atan2(p.vy, p.vx),
              -(Math.abs(p.vx) + Math.abs(p.vy)) * 0.022,
              p.size * 2.6,
              (1 - t) * 0.8,
            );
          }
          blit(ctx, sprite.spark, p.x, p.y, p.size * (1 - t * 0.5) * 1.6, 1 - t);
          break;
        case "ring":
          // Expanding shockwave. Hollow by construction, so it rides over a
          // fresh hole without painting the void back in.
          blit(
            ctx,
            sprite.shockRing,
            p.x,
            p.y,
            p.size * (0.35 + t * 1.9),
            (1 - t) * (1 - t) * 0.85,
          );
          break;
        case "streak":
          blitStreak(
            ctx,
            sprite.streakHot,
            p.x,
            p.y,
            p.angle ?? 0,
            p.len ?? 40,
            p.size,
            (1 - t) * 0.9,
          );
          break;
        case "jet": {
          // Flamethrower fuel: white-hot at the nozzle, swelling and cooling as
          // it flies. The size ramp is what turns a line of dots into a cone.
          const r = p.size * (0.5 + t * 2.6);
          blit(ctx, t < 0.3 ? sprite.flameCore : sprite.flameHigh, p.x, p.y, r, (1 - t) * 0.62);
          blit(ctx, sprite.flameLow, p.x, p.y, r * 1.35, (1 - t) * 0.34);
          break;
        }
        case "spaghetti": {
          // Tidal stretching: the faster it falls, the longer it draws. Colour
          // splits between violet and amber so the disc looks like it has
          // temperature structure rather than being one glowing smear.
          const speed = Math.hypot(p.vx, p.vy);
          blitStreak(
            ctx,
            p.color === "#c98bff" ? sprite.streakWater : sprite.streakHot,
            p.x,
            p.y,
            Math.atan2(p.vy, p.vx),
            -Math.min(90, speed * 0.11),
            p.size * 2.2,
            (1 - t) * 0.7,
          );
          break;
        }
        case "sparkle": {
          // Twinkle: on/off rather than a smooth fade, so it reads as a glint.
          const tw = 0.5 + 0.5 * Math.sin(time * 22 + (p.phase ?? 0));
          blit(ctx, sprite.sparkle, p.x, p.y, p.size * (0.6 + tw * 0.8), (1 - t) * tw);
          break;
        }
        default:
          // Muzzle/impact flash: a warm halo with a white-hot centre. Warm alone
          // reads as a fireball; white alone reads as a lens flare.
          blit(ctx, sprite.flash, p.x, p.y, p.size, 0.55 * (1 - t));
          blit(ctx, sprite.flashWhite, p.x, p.y, p.size * 0.68, 1 - t);
      }
    }
  }
}

/**
 * Flickering multi-layer flame: glowing char rim, body, licking tongue, core.
 *
 * Baked sprites rather than freshly built radial gradients; the flicker lives
 * entirely in the per-draw scale and alpha, which are plain numbers.
 *
 * Two frequencies drive every offset — a slow sway and a fast jitter. One
 * frequency is a wobble; two is the shimmer that reads as heat.
 */
export function drawFlame(ctx: CanvasRenderingContext2D, f: Flame, time: number, layers: number) {
  const flicker =
    0.85 + 0.15 * Math.sin(time * 13 + f.seed) + 0.08 * Math.sin(time * 29 + f.seed * 2);
  const r = f.radius * f.intensity * flicker;
  if (r < 1) return;
  const { x, y } = f;
  const sprite = sprites();

  // Ambient glow (taller than wide — light pools above a fire), then the hot
  // rim: the burnt edge of the hole glowing where the fire is still eating it.
  // The ring sprite is hollow and drawn flat to the page, so it lights the rim
  // without filling in the hole it surrounds or reading as a bubble.
  blitRect(ctx, sprite.glow, x, y - r * 0.5, r * 1.9, r * 2.5, 0.17 * f.intensity);
  blitRect(
    ctx,
    sprite.heatRing,
    x,
    y + r * 0.2,
    r * 1.85,
    r * 0.8,
    0.2 * f.intensity * (0.85 + 0.15 * Math.sin(time * 7 + f.seed)),
  );

  // Flame body — a column of vertical ellipses, narrower and hotter toward the
  // top, rising well clear of the hole so the fire licks upward. Five layers,
  // not seven: with dozens of flames alight this loop is the render path's
  // hottest blit site, and the two dropped layers were overdraw inside the
  // column, not silhouette.
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const ly = y - r * 2.9 * t;
    const lr = r * (0.82 - t * 0.58) * (0.88 + 0.18 * Math.sin(time * 17 + f.seed + i * 2.1));
    const wobble =
      Math.sin(time * 9 + f.seed + i * 1.7) * r * 0.36 * t +
      Math.sin(time * 24 + f.seed * 3 + i) * r * 0.12 * t;
    const hot = t >= 0.3;
    blitRect(
      ctx,
      hot ? sprite.flameHigh : sprite.flameLow,
      x + wobble,
      ly,
      lr,
      lr * 1.65,
      (hot ? 0.4 : 0.48) * f.intensity,
    );
  }

  // A tongue that detaches off the top and gutters out — the thing real fire
  // does that a stack of circles never will.
  const lick = 0.5 + 0.5 * Math.sin(time * 7.3 + f.seed * 1.7);
  if (lick > 0.42) {
    blitRect(
      ctx,
      sprite.flameHigh,
      x + Math.sin(time * 11 + f.seed) * r * 0.7,
      y - r * (3.1 + lick * 1.9),
      r * 0.26 * lick,
      r * 0.62 * lick,
      0.42 * f.intensity * lick,
    );
  }

  // White-hot core at the base.
  blitRect(ctx, sprite.flameCore, x, y - r * 0.3, r * 0.5, r * 0.86, 0.85 * f.intensity);
}

/**
 * The singularity's event horizon. Drawn source-over, not additively — the one
 * thing on this layer whose job is to be a hole rather than a light.
 */
export function drawEventHorizon(ctx: CanvasRenderingContext2D, s: Singularity) {
  blit(ctx, sprites().singularity, s.x, s.y, s.radius * s.charge, 1);
  ctx.globalAlpha = 1;
}

/**
 * The accretion band around the horizon, counter-rotating against the infall
 * and pulsing, so the hole never sits still even when nothing is being eaten.
 * Additive: the caller has already switched the context to `lighter`.
 */
export function drawAccretionDisc(ctx: CanvasRenderingContext2D, s: Singularity, time: number) {
  const r = s.radius * s.charge;
  const sprite = sprites();
  const wobble = 0.9 + 0.1 * Math.sin(time * 9);
  blitRect(ctx, sprite.accretion, s.x, s.y, r * 2.1 * wobble, r * 1.5 * wobble, 0.85);
  blitRect(ctx, sprite.accretion, s.x, s.y, r * 2.9, r * 0.72, 0.5);
  blit(ctx, sprite.glow, s.x, s.y, r * 3.4, 0.16 * s.charge);
  ctx.globalAlpha = 1;
}

/**
 * The keyboard aiming cursor.
 *
 * Deliberately unlike every tool's own art: a high-contrast reticle with a
 * dark outline under a light stroke, so it stays legible over a white page, a
 * burnt one, and the void alike, and a slow pulse so it can be found at a
 * glance without reading as an effect.
 */
export function drawAimCursor(
  ctx: CanvasRenderingContext2D,
  point: { x: number; y: number },
  time: number,
) {
  const pulse = 1 + Math.sin(time * 4) * 0.08;
  const radius = 15 * pulse;
  const arm = 9;

  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.lineCap = "round";

  for (const [width, color] of [
    [4.5, "rgba(0, 0, 0, 0.65)"],
    [2, "rgba(255, 255, 255, 0.95)"],
  ] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      ctx.moveTo(point.x + dx * (radius + 3), point.y + dy * (radius + 3));
      ctx.lineTo(point.x + dx * (radius + 3 + arm), point.y + dy * (radius + 3 + arm));
    }
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.beginPath();
  ctx.arc(point.x, point.y, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
