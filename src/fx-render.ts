/**
 * Drawing for the effects layer: particles, flames, and the singularity.
 *
 * Everything here is pure paint, so `RageLayerEngine.render` is left as a
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

/**
 * Experiment switch: draw each dust particle by stamping a cached three-lobe
 * `Path2D` cluster with one `setTransform` + `fill(cluster)` instead of
 * appending three fresh `ctx.ellipse(...)` lobes to a chunked context path.
 * Appending an ellipse flattens the arc into curves on every call; filling a
 * canned path skips path construction entirely. Flip to `false` to restore the
 * chunked `moveTo`/`ellipse` appends.
 *
 * Measured (perf suite, 6x CPU, swarm, 8s): the append path spent 585ms in
 * `ellipse` + 213ms in `moveTo`/`fill`; the stamp spends ~260ms in
 * `setTransform` + ~112ms in `fill` — a ~53% cut in the dust fills' self-time
 * (stable across two runs) with p50/p95 unchanged. The same stamping applied
 * to the water droplet and splash fills (one lobe per particle rather than
 * three) was a wash and is not used: what the stamp saves in path building it
 * pays back in per-particle `setTransform`, so it only wins where one stamp
 * replaces several appends.
 */
const USE_DUST_CLUSTER_PATH = true;

/**
 * One dust particle's full three-lobe cluster at swell = 1, with exactly the
 * lobe geometry of the append path below. Every lobe offset and radius scales
 * with swell, so the cluster is a rigid shape: drawing it under
 * base · Translate(x, y) · Scale(swell, swell) reproduces the three
 * `ellipse(...)` calls (`Path2D.ellipse` builds the same curve approximation
 * with the same default winding, and a uniform scale maps each unit-cluster
 * lobe `ellipse(cx, cy, rx, ry, rot)` to `ellipse(x + cx·s, y + cy·s, rx·s,
 * ry·s, rot)` — rotation survives uniform scaling unchanged).
 *
 * The one intentional difference: the cluster fills once per particle, so
 * where the three lobes of one particle overlap they composite once, exactly
 * as the original pre-batching renderer drew them; the chunked appends merge
 * up to 8 particles into one fill instead. At dust's ≤ 0.075 alpha the
 * difference is sub-perceptual.
 *
 * Built lazily: the test DOM installs the `Path2D` global after the source
 * modules evaluate, and a plain browser build has it from the start. `null`
 * means unsupported (or the switch is off) and the ellipse appends are used.
 */
let dustCluster: Path2D | null | undefined;

function dustClusterPath(): Path2D | null {
  if (dustCluster === undefined) {
    if (USE_DUST_CLUSTER_PATH && typeof Path2D === "function") {
      dustCluster = new Path2D();
      dustCluster.ellipse(0, 0, 1, 0.34, 0, 0, TAU);
      dustCluster.ellipse(-0.62, 0.08, 0.58, 0.25, -0.12, 0, TAU);
      dustCluster.ellipse(0.52, -0.1, 0.5, 0.22, 0.1, 0, TAU);
    } else {
      dustCluster = null;
    }
  }
  return dustCluster;
}

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

  /**
   * Scratch for batching same-colour ellipse fills by alpha, quantised to
   * 1/128 steps — under half an 8-bit output level, so the rounding is
   * invisible while hundreds of `fill` calls collapse into a handful. Index is
   * the quantised alpha; `bucketOrder` lists the occupied slots so a frame
   * never sweeps all 129. Reused across groups within a frame, allocation-free.
   */
  private readonly alphaBuckets: Particle[][] = Array.from({ length: 129 }, () => []);
  private readonly bucketOrder: number[] = [];

  /**
   * Subpaths per fill within a batch. Appending to the context path gets more
   * expensive as the path grows (measured ~6x per-append at ~1000 subpaths in
   * the flood stress scenario), so batches flush in small chunks: state is
   * still set once per bucket, but no path ever grows past this many shapes.
   */
  private static readonly FILL_CHUNK = 24;

  /** Drop every retained reference (the engine is going away). */
  clear() {
    this.wet.length = this.puff.length = this.bit.length = this.hot.length = 0;
  }

  /** True when the last `classify` found particles that draw onto the page. */
  get hasSurfaceParticles(): boolean {
    return this.wet.length > 0;
  }

  // Bucket sizes from the most recent `classify`, for render telemetry only.
  get wetCount(): number {
    return this.wet.length;
  }
  get puffCount(): number {
    return this.puff.length;
  }
  get solidCount(): number {
    return this.bit.length;
  }
  get hotCount(): number {
    return this.hot.length;
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
        case "acid":
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
      if (p.kind === "stream") {
        const t = p.life / p.maxLife;
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
        const t = p.life / p.maxLife;
        // A run of water sliding down the page: a fading tail behind a bead.
        // The bead lands on its own tail, so the pair stays interleaved per
        // particle instead of joining the batched droplet fills below.
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
      if (p.kind === "acid") {
        const t = p.life / p.maxLife;
        const alpha = 1 - t * 0.72;
        const tail = p.len ?? 0;
        // Acid is heavier and more cohesive than water: a continuous luminous
        // run with a glossy core, rather than a translucent blue sprite.
        ctx.save();
        ctx.lineCap = "round";
        ctx.strokeStyle = p.color ?? "#8de323";
        ctx.lineWidth = p.size * 1.8;
        ctx.globalAlpha = 0.72 * alpha;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - tail);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.strokeStyle = p.color2 ?? "#dcff63";
        ctx.lineWidth = Math.max(0.8, p.size * 0.48);
        ctx.globalAlpha = 0.82 * alpha;
        ctx.stroke();
        ctx.fillStyle = p.color ?? "#8de323";
        ctx.globalAlpha = 0.9 * alpha;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size * 0.9, p.size * 1.3, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    }
    // Droplets: hundreds of tiny same-colour ellipses. Same-colour source-over
    // commutes, so each style batches into one path filled once (the `moveTo`
    // keeps subpaths from connecting). Water's alpha is constant; splashes
    // fade, so they group through the quantised alpha buckets.
    ctx.fillStyle = "rgb(140, 190, 240)";
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    let pending = 0;
    for (const p of this.wet) {
      if (p.kind !== "water") continue;
      ctx.moveTo(p.x, p.y);
      ctx.ellipse(
        p.x,
        p.y,
        p.size * 0.7,
        p.size * 1.3,
        Math.atan2(p.vy, p.vx) + Math.PI / 2,
        0,
        TAU,
      );
      if (++pending === FxPainter.FILL_CHUNK) {
        ctx.fill();
        ctx.beginPath();
        pending = 0;
      }
    }
    if (pending > 0) ctx.fill();
    const buckets = this.alphaBuckets;
    const order = this.bucketOrder;
    order.length = 0;
    for (const p of this.wet) {
      if (p.kind !== "splash") continue;
      const q = Math.round(0.7 * (1 - p.life / p.maxLife) * 128);
      if (q === 0) continue;
      if (buckets[q].length === 0) order.push(q);
      buckets[q].push(p);
    }
    ctx.fillStyle = "rgb(160, 200, 240)";
    for (const q of order) {
      const bucket = buckets[q];
      ctx.globalAlpha = q / 128;
      ctx.beginPath();
      let run = 0;
      for (const p of bucket) {
        ctx.moveTo(p.x, p.y);
        ctx.ellipse(
          p.x,
          p.y,
          p.size * 0.7,
          p.size * 1.3,
          Math.atan2(p.vy, p.vx) + Math.PI / 2,
          0,
          TAU,
        );
        if (++run === FxPainter.FILL_CHUNK) {
          ctx.fill();
          ctx.beginPath();
          run = 0;
        }
      }
      if (run > 0) ctx.fill();
      bucket.length = 0;
    }
    ctx.globalAlpha = 1;
  }

  /** Smoke, steam and dust: normal blending, soft grey/white. */
  drawPuffs(ctx: CanvasRenderingContext2D, time: number) {
    const sprite = sprites();
    // Keep impact dust close to the contact plane. A scaled radial sprite
    // reads as a soap bubble when many debris collisions overlap, so dust
    // uses a few small, flattened lobes instead of an expanding disc. One
    // colour and hundreds of particles per frame make it the poster child for
    // the alpha buckets: one `fill` per alpha step instead of one each. Dust
    // draws before smoke and steam — it hugs the ground they rise from, and at
    // ≤0.075 alpha the compositing order against them is imperceptible anyway.
    const buckets = this.alphaBuckets;
    const order = this.bucketOrder;
    order.length = 0;
    for (const p of this.puff) {
      if (p.kind !== "dust") continue;
      const t = p.life / p.maxLife;
      const q = Math.round(0.075 * (1 - t) * Math.min(1, t * 8) * 128);
      if (q === 0) continue;
      if (buckets[q].length === 0) order.push(q);
      buckets[q].push(p);
    }
    ctx.fillStyle = "rgb(202, 194, 182)";
    // Dust appends three lobes per particle, so it chunks at a third the rate.
    const dustChunk = FxPainter.FILL_CHUNK / 3;
    // Touch the transform only when there is dust to draw: the capture/restore
    // pair costs real time per frame (the restore absorbs a queue flush), so a
    // dust-free frame must not pay it.
    const cluster = order.length > 0 ? dustClusterPath() : null;
    let ma = 1;
    let mb = 0;
    let mc = 0;
    let md = 1;
    let me = 0;
    let mf = 0;
    if (cluster) {
      const m = ctx.getTransform();
      ma = m.a;
      mb = m.b;
      mc = m.c;
      md = m.d;
      me = m.e;
      mf = m.f;
    }
    for (const q of order) {
      const bucket = buckets[q];
      ctx.globalAlpha = q / 128;
      if (cluster) {
        // The whole three-lobe cluster scales rigidly with swell, so one
        // uniform-scale stamp of the baked cluster replaces three appends.
        for (const p of bucket) {
          const t = p.life / p.maxLife;
          const swell = Math.min(10, p.size * (0.72 + t * 0.48));
          ctx.setTransform(
            ma * swell,
            mb * swell,
            mc * swell,
            md * swell,
            ma * p.x + mc * p.y + me,
            mb * p.x + md * p.y + mf,
          );
          ctx.fill(cluster);
        }
      } else {
        ctx.beginPath();
        let run = 0;
        for (const p of bucket) {
          const t = p.life / p.maxLife;
          const swell = Math.min(10, p.size * (0.72 + t * 0.48));
          ctx.moveTo(p.x, p.y);
          ctx.ellipse(p.x, p.y, swell, swell * 0.34, 0, 0, TAU);
          ctx.ellipse(
            p.x - swell * 0.62,
            p.y + swell * 0.08,
            swell * 0.58,
            swell * 0.25,
            -0.12,
            0,
            TAU,
          );
          ctx.ellipse(
            p.x + swell * 0.52,
            p.y - swell * 0.1,
            swell * 0.5,
            swell * 0.22,
            0.1,
            0,
            TAU,
          );
          if (++run >= dustChunk) {
            ctx.fill();
            ctx.beginPath();
            run = 0;
          }
        }
        if (run > 0) ctx.fill();
      }
      bucket.length = 0;
    }
    if (cluster) ctx.setTransform(ma, mb, mc, md, me, mf);
    for (const p of this.puff) {
      if (p.kind === "dust") continue;
      const t = p.life / p.maxLife;
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
    if (this.bit.length === 0) return;
    // One matrix read per frame; each tumbling solid then costs a single
    // `setTransform` (the base composed with its own translate·rotate) instead
    // of a save/translate/rotate/restore quartet, and the base goes back once
    // at the end. Paint drips draw in document space, so the base transform is
    // restored before each of those.
    const m = ctx.getTransform();
    const ma = m.a;
    const mb = m.b;
    const mc = m.c;
    const md = m.d;
    const me = m.e;
    const mf = m.f;
    let placed = false;
    ctx.lineWidth = 1;
    for (const p of this.bit) {
      const t = p.life / p.maxLife;
      if (p.kind === "paint") {
        if (placed) {
          ctx.setTransform(ma, mb, mc, md, me, mf);
          placed = false;
        }
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
      const angle = p.angle ?? 0;
      let cos = 1;
      let sin = 0;
      if (angle !== 0) {
        cos = Math.cos(angle);
        sin = Math.sin(angle);
      }
      ctx.setTransform(
        ma * cos + mc * sin,
        mb * cos + md * sin,
        mc * cos - ma * sin,
        md * cos - mb * sin,
        ma * p.x + mc * p.y + me,
        mb * p.x + md * p.y + mf,
      );
      placed = true;
      ctx.globalAlpha = 1 - t * t;
      if (p.kind === "shard" && p.img) {
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
    }
    ctx.setTransform(ma, mb, mc, md, me, mf);
    ctx.globalAlpha = 1;
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
 * Flickering flame: glowing char rim, coherent body, and a detached tongue.
 *
 * The body is one baked, continuous silhouette rather than a stack of radial
 * sprites. Flicker lives entirely in per-draw scale, sway, and alpha, which
 * are plain numbers. High quality therefore needs four blits per flame instead
 * of nine, while the outline reads more like fire and less like glowing beads.
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

  // One continuous flame body. It is baked with its base at the sprite's lower
  // edge, so destination placement keeps it planted on the burning surface as
  // the width and height breathe independently.
  const bodySway =
    Math.sin(time * 8.7 + f.seed) * r * 0.22 + Math.sin(time * 21 + f.seed * 2.3) * r * 0.08;
  const bodyWidth = r * (1.05 + 0.1 * Math.sin(time * 17 + f.seed));
  const bodyHeight = r * (3.5 + 0.25 * Math.sin(time * 11 + f.seed * 1.4));
  // Intensity already scales the silhouette through `r`. Applying it a second
  // time to alpha made young/spreading flames disappear behind their smoke.
  ctx.globalAlpha = (layers <= 2 ? 0.5 : 0.58) + f.intensity * 0.3;
  ctx.drawImage(
    sprite.flameBody,
    x + bodySway - bodyWidth,
    y - bodyHeight + r * 0.32,
    bodyWidth * 2,
    bodyHeight,
  );

  // A tongue that detaches off the top and gutters out — the thing real fire
  // does that a stack of circles never will.
  const lick = 0.5 + 0.5 * Math.sin(time * 7.3 + f.seed * 1.7);
  if (layers >= 4 && lick > 0.42) {
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
