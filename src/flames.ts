/**
 * FlameField — fire, and the wood it eats.
 *
 * Fire is the engine's one ecological effect: it needs ground to stand on (a
 * flame never lives over the void), fuel to consume, and it loses to water.
 * Everything about burning lives here — the flame list, the
 * cap, spread, and the fuel grid.
 *
 * The page is material with finite fuel rather than an infinite wick: each
 * grid cell holds a store that burning consumes, flames starve where it runs
 * out, and spread only takes where fuel remains. That is what makes a blaze
 * gutter out where it has already eaten through.
 *
 * `FlameHost` below is a subset of the public `DestroyerEngineApi` — the same
 * surface a third-party tool works against.
 */

import type { ComboEvent, InteractionKind } from "./combos";
import { drawScorch } from "./decals";
import { type FieldSnapshot, ScalarField } from "./fields";
import { TAU } from "./math";
// Fire is the highest-rate particle spawner in the engine, so every spawn
// site here fills the shared scratch (which `ParticleSystem.spawn` copies out
// of, synchronously) instead of allocating a literal per ember and puff.
import { scratchParticle } from "./particles";
import type { ContentApi, Flame, Particle, SoundApi } from "./types";
import { WOOD } from "./wood.js";

/**
 * Wood-fuel grid resolution, CSS px per cell. Coarse cells are enough — the
 * questions asked are "can fire live here" and "how hungry is it", both
 * regional.
 */
const FUEL_CELL = 26;

/** Absolute floor for the flame cap, whatever the quality profile says. */
const MIN_LIMIT = 4;
/** Smoke puffs per second at full intensity. Kept below the flame cadence so smoke reveals fire. */
const SMOKE_PUFFS_PER_SECOND = 8;

/** The slice of the engine fire touches. */
export interface FlameHost {
  readonly width: number;
  readonly height: number;
  readonly content: ContentApi | null;
  readonly damageCtx: CanvasRenderingContext2D;
  readonly sound: SoundApi;
  pageOpacityAt(x: number, y: number): number;
  spawnParticle(p: Particle): void;
  signalInteraction(kind: InteractionKind, x: number, y: number): ComboEvent[];
}

export class FlameField {
  /** Every flame alight. Read by the renderer and by anything fire interacts with. */
  readonly list: Flame[] = [];
  /** Wood fuel per grid cell, 0..255. Built lazily at the first flame. */
  private readonly fuel = new ScalarField({
    cell: FUEL_CELL,
    max: 255,
    initial: 255,
  });
  private limit = MIN_LIMIT;
  /** Rate gates so repeated hits don't stack into a buzz. */
  private nextHiss = 0;
  private nextPop = 0;
  /**
   * Cache for `totalIntensity`. The engine asks at least twice per frame
   * (bloom, fire-loop volume); every site that changes an intensity marks
   * this dirty, so the sum is walked at most once per frame and stays exact.
   */
  private cachedIntensity = 0;
  private intensityDirty = true;

  get count(): number {
    return this.list.length;
  }

  /** Combined intensity — what the looping fire sound is scaled by. */
  get totalIntensity(): number {
    if (this.intensityDirty) {
      let total = 0;
      for (const f of this.list) total += f.intensity;
      this.cachedIntensity = total;
      this.intensityDirty = false;
    }
    return this.cachedIntensity;
  }

  setLimit(limit: number) {
    this.limit = Math.max(MIN_LIMIT, Math.round(limit));
    if (this.list.length > this.limit) {
      this.list.length = this.limit;
      this.intensityDirty = true;
    }
  }

  /** Put every fire out. The fuel grid is untouched — burnt wood stays burnt. */
  clear() {
    this.list.length = 0;
    this.intensityDirty = true;
  }

  /** Repaired page, fresh wood: the fuel comes back with the pixels. */
  refuel() {
    this.fuel.reset();
  }

  /** Drop everything, including the fuel grid. */
  dispose() {
    this.list.length = 0;
    this.intensityDirty = true;
    this.fuel.release();
  }

  /** Retained fuel bytes, for the undo-history budget. */
  get fuelBytes(): number {
    return this.fuel.byteLength;
  }

  snapshotFuel(): FieldSnapshot | null {
    return this.fuel.snapshot();
  }

  restoreFuel(snapshot: FieldSnapshot | null) {
    this.fuel.restore(snapshot);
  }

  /** Remaining fuel under (x, y), 0..1. Unburnt page reads 1. */
  private fuelAt(x: number, y: number): number {
    return this.fuel.at(x, y) / 255;
  }

  /**
   * Burn away fuel under (x, y), and a quarter as much in the four cells around
   * it — a fire burning through one board scorches the boards beside it before
   * they catch.
   */
  private consumeFuel(host: FlameHost, x: number, y: number, amount: number) {
    this.fuel.ensure(host.width, host.height);
    this.fuel.addCross(x, y, -amount, 0.25);
  }

  /** Returns true when a new flame was actually lit (the caller repaints). */
  spawn(host: FlameHost, x: number, y: number, intensity = 0.35): boolean {
    this.fuel.ensure(host.width, host.height);
    intensity *= WOOD.flammability;
    if (intensity <= 0.015) return false;
    // Fire needs a page to burn. Where the content is mostly gone the void
    // shows through, and the void is not a place — a flame floating on it
    // reads as a rendering bug, not as fire. Strict on purpose: half-eroded
    // ground barely holds a flame's footprint, and the render mask would clip
    // most of it away anyway.
    if (host.content?.ready && host.pageOpacityAt(x, y) < 0.35) return false;
    // Merge into a nearby flame instead of stacking duplicates. Same shape as
    // the dowse scan: axis reject, then squared distance — no square root.
    for (const f of this.list) {
      const reach = f.radius * 0.6;
      const dx = f.x - x;
      if (dx > reach || dx < -reach) continue;
      const dy = f.y - y;
      if (dy > reach || dy < -reach) continue;
      if (dx * dx + dy * dy < reach * reach) {
        f.intensity = Math.min(1, f.intensity + intensity * 0.5);
        this.intensityDirty = true;
        host.signalInteraction("fire", x, y);
        return false;
      }
    }
    if (this.list.length >= this.limit) return false;
    this.intensityDirty = true;
    this.list.push({
      x,
      y,
      intensity,
      radius: 17 + Math.random() * 21,
      age: 0,
      seed: Math.random() * 1000,
      spreadCooldown: 0.45 + Math.random() * 0.55,
      scorchCooldown: 0.4,
      popCooldown: 1 + Math.random() * 3,
    });
    host.signalInteraction("fire", x, y);
    return true;
  }

  dowse(
    host: FlameHost,
    now: number,
    x: number,
    y: number,
    radius: number,
    amount: number,
  ): number {
    let hits = 0;
    for (const f of this.list) {
      // Called once per water droplet per frame against every flame, so the
      // reject path has to be cheap: axis test first, then squared distance —
      // no `Math.hypot`, no square root.
      const reach = radius + f.radius;
      const dx = f.x - x;
      if (dx > reach || dx < -reach) continue;
      const dy = f.y - y;
      if (dy > reach || dy < -reach) continue;
      if (dx * dx + dy * dy < reach * reach) {
        f.intensity -= amount;
        this.intensityDirty = true;
        hits++;
        if (Math.random() < 0.4) {
          // Quenching steam boils *upward and outward* off the flame, so it gets
          // real lateral spread rather than the near-vertical wisp it had.
          const p = scratchParticle(
            "steam",
            f.x + (Math.random() - 0.5) * f.radius * 1.4,
            f.y - Math.random() * 10,
            (Math.random() - 0.5) * 90,
            -70 - Math.random() * 90,
            1 + Math.random() * 1.1,
            10 + Math.random() * 18,
          );
          p.drag = 1.4;
          host.spawnParticle(p);
        }
      }
    }
    // The hiss belongs to the *event* of water meeting fire, not to each of the
    // hundred droplet/flame pairs that can register in a single frame.
    if (hits > 0 && now > this.nextHiss) {
      this.nextHiss = now + 260;
      host.sound.hiss();
    }
    return hits;
  }

  step(host: FlameHost, dt: number, now: number) {
    // Every live flame's intensity relaxes below, so one mark covers the step.
    if (this.list.length > 0) this.intensityDirty = true;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const f = this.list[i];
      f.age += dt;
      // Fire lives on fuel: a full flame over fresh wood, a starving flicker
      // over spent. Age still winds it down eventually, but exhausting the
      // cell underneath is what actually kills a fire now — which is why a
      // blaze gutters out where it has already eaten through instead of
      // burning in place forever.
      const fuel = this.fuelAt(f.x, f.y);
      const starved = fuel < 0.06;
      const target = f.age < 12 && !starved ? 0.35 + 0.65 * fuel : 0;
      f.intensity += (target - f.intensity) * dt * (f.age < 12 && !starved ? 0.35 : 0.12);

      // Fire consumes the page in stages: it catches (chars the surface),
      // burns (erodes into the material), deepens (heavy erosion, spent fuel),
      // and finally breaks through — the hole opens onto the void and the
      // flame dies with it, because the void has nothing left to burn.
      f.scorchCooldown -= dt;
      if (f.scorchCooldown <= 0 && f.intensity > 0.15) {
        // Jittered rather than a flat 0.3s: with a fixed period every flame
        // lit in the same frame stays in lockstep forever, so all of them
        // repaint the (document-sized) content canvas on the same frame.
        f.scorchCooldown = 0.26 + Math.random() * 0.14;
        const layer = host.content;
        if (layer?.ready) {
          const opacity = host.pageOpacityAt(f.x, f.y);
          if (opacity < 0.25 || (fuel < 0.05 && f.age > 1.5)) {
            // Stage 4 — breakthrough. The material under the flame is gone:
            // open the hole cleanly, throw one last gasp of embers and smoke,
            // and put the flame out. Fire never lives over the void.
            layer.punch(f.x, f.y, f.radius * 0.55);
            for (let s = 0; s < 6; s++) {
              const a = Math.random() * TAU;
              const p = scratchParticle(
                "ember",
                f.x + Math.cos(a) * f.radius * 0.5,
                f.y + Math.sin(a) * f.radius * 0.4,
                Math.cos(a) * (30 + Math.random() * 60),
                -40 - Math.random() * 80,
                0.8 + Math.random() * 1,
                1.5 + Math.random() * 2,
              );
              p.gravity = 40;
              p.drag = 1.2;
              host.spawnParticle(p);
            }
            for (let s = 0; s < 3; s++) {
              const p = scratchParticle(
                "smoke",
                f.x + (Math.random() - 0.5) * f.radius,
                f.y - Math.random() * 8,
                (Math.random() - 0.5) * 20,
                -50 - Math.random() * 40,
                1.4 + Math.random(),
                8 + Math.random() * 8,
              );
              p.drag = 1.3;
              host.spawnParticle(p);
            }
            this.list.splice(i, 1);
            continue;
          }
          if (f.age < 0.8) {
            // Stage 1 — catching: the surface darkens but nothing is lost yet.
            layer.char(f.x, f.y + 2, f.radius * 0.5, 0.1);
          } else if (fuel > 0.5) {
            // Stage 2 — burning: the char deepens and erosion begins.
            layer.char(f.x, f.y + 2, f.radius * 0.85, 0.16);
            layer.burn(f.x, f.y + 2, f.radius * 0.22);
            this.consumeFuel(host, f.x, f.y, (9 + 13 * f.intensity) * WOOD.burnRate);
          } else {
            // Stage 3 — deepening: the fire is inside the material now, eating
            // fast toward breakthrough, and the rim glows with thrown embers.
            layer.burn(f.x, f.y + 2, f.radius * (0.3 + f.intensity * 0.35));
            this.consumeFuel(host, f.x, f.y, (13 + 16 * f.intensity) * WOOD.burnRate);
            if (Math.random() < 0.5) {
              const a = Math.random() * TAU;
              const p = scratchParticle(
                "ember",
                f.x + Math.cos(a) * f.radius * 0.6,
                f.y + Math.sin(a) * f.radius * 0.4,
                (Math.random() - 0.5) * 30,
                -20 - Math.random() * 40,
                1 + Math.random(),
                1.4 + Math.random() * 1.8,
              );
              p.gravity = -6;
              p.drag = 1.6;
              host.spawnParticle(p);
            }
          }
        } else {
          drawScorch(
            host.damageCtx,
            f.x + (Math.random() - 0.5) * 8,
            f.y + 4 + (Math.random() - 0.5) * 6,
            f.radius * (0.5 + f.intensity * 0.5),
            0.05 + f.intensity * 0.06,
          );
        }
      }

      // Fire spreads through contact heat, not by throwing unrelated random
      // fires across the page. Each attempt creeps around the current flame's
      // rim, biased upward, and only catches where both intact wood and local
      // fuel remain. Cooldown overshoot is carried forward, so a 30 Hz frame
      // and two 60 Hz frames produce the same number of spread opportunities.
      f.spreadCooldown -= dt;
      let spreadAttempts = 0;
      while (f.spreadCooldown <= 0 && spreadAttempts++ < 2) {
        f.spreadCooldown += 0.55 + Math.random() * 0.45;
        if (f.intensity < 0.48 || this.list.length >= this.limit) continue;

        let localHeat = f.intensity * (0.55 + fuel * 0.45);
        for (const neighbour of this.list) {
          if (neighbour === f) continue;
          // Only flames actually in contact contribute, so reject the rest
          // before the square root: axis test first, then squared distance.
          const reach = f.radius + neighbour.radius * 1.4;
          const dx = neighbour.x - f.x;
          if (dx > reach || dx < -reach) continue;
          const dy = neighbour.y - f.y;
          if (dy > reach || dy < -reach) continue;
          const d2 = dx * dx + dy * dy;
          if (d2 >= reach * reach) continue;
          const contact = 1 - Math.sqrt(d2) / reach;
          localHeat += neighbour.intensity * contact * 0.22;
        }
        if (localHeat < 0.5) continue;

        // Tangential jitter creates irregular fronts, while the short step
        // keeps every child in thermal contact with its parent.
        const angle = Math.random() * TAU;
        const dist = f.radius * (0.72 + Math.random() * 0.52);
        let offsetX = Math.cos(angle) * dist;
        let offsetY = Math.sin(angle) * dist * 0.72 - dist * (0.12 + localHeat * 0.12);
        // The upward heat bias can shorten some vectors enough that `spawn()`
        // merges them straight back into the parent. Push those candidates to
        // the rim so every eligible spread opportunity advances the front.
        const offsetLength2 = offsetX * offsetX + offsetY * offsetY;
        const minimumStep = f.radius * 0.68;
        if (offsetLength2 < minimumStep * minimumStep) {
          const scale = minimumStep / Math.max(0.001, Math.sqrt(offsetLength2));
          offsetX *= scale;
          offsetY *= scale;
        }
        const nx = f.x + offsetX;
        const ny = f.y + offsetY;
        if (nx <= 0 || nx >= host.width || ny <= 0 || ny >= host.height) continue;
        const nextFuel = this.fuelAt(nx, ny);
        const surface = host.content?.ready ? host.pageOpacityAt(nx, ny) : 1;
        if (nextFuel < 0.28 || surface < 0.5) continue;
        this.spawn(host, nx, ny, 0.16 + Math.min(0.2, localHeat * nextFuel * 0.14));
      }

      // Sap-pocket pops: an audible crack that throws a fistful of embers, so a
      // sustained fire keeps startling you instead of settling into wallpaper.
      f.popCooldown -= dt;
      if (f.popCooldown <= 0 && f.intensity > 0.55) {
        f.popCooldown = 1.8 + Math.random() * 4;
        for (let s = 0; s < 5 + Math.floor(Math.random() * 5); s++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
          const speed = 110 + Math.random() * 220;
          const p = scratchParticle(
            "ember",
            f.x,
            f.y - f.radius * 0.4,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            0.7 + Math.random() * 0.8,
            1.8 + Math.random() * 2.6,
          );
          p.gravity = 130;
          p.drag = 1.1;
          host.spawnParticle(p);
        }
        if (now > this.nextPop) {
          this.nextPop = now + 280;
          host.sound.pop();
        }
      }

      // Smoke + embers. Rates are per *second* and scaled by dt: as per-frame
      // probabilities they doubled on a 120Hz display, which is exactly where
      // the frame budget is already halved — the particle cap then sat pinned
      // and every extra puff was overdraw nobody asked for.
      if (f.intensity > 0.2) {
        // Smoke is the single biggest particle cost of a big fire: each puff
        // lives for seconds and is drawn twice while warm. A restrained plume
        // leaves the luminous body readable instead of burying it under an
        // opaque stack, while also bounding overdraw in a 32-flame blaze.
        if (Math.random() < f.intensity * SMOKE_PUFFS_PER_SECOND * dt) {
          // Rolling column: puffs are launched hard, then dragged to a crawl, so
          // they bunch up and billow overhead instead of streaming away as dots.
          const p = scratchParticle(
            "smoke",
            f.x + (Math.random() - 0.5) * f.radius,
            f.y - f.radius * 0.9,
            (Math.random() - 0.5) * 55,
            -70 - Math.random() * 90 * f.intensity,
            1.4 + Math.random() * 1.3,
            12 + Math.random() * 18 * f.intensity,
          );
          p.gravity = -18;
          p.drag = 1.5;
          p.spin = (Math.random() - 0.5) * 1.2;
          p.angle = Math.random() * TAU;
          p.phase = Math.random() * TAU;
          host.spawnParticle(p);
        }
        if (Math.random() < f.intensity * 6 * dt) {
          // A third of the shed embers are *drifters*: caught in the thermal
          // plume, they ride up and sideways for a couple of seconds, cooling
          // through the whole white-orange → red → dark arc before they die
          // (the render pass keys the sprite and sway off `phase`/age). The
          // rest stay the quick, heavy pops that arc down and wink out.
          const drifter = Math.random() < 0.35;
          const p = scratchParticle(
            "ember",
            f.x + (Math.random() - 0.5) * f.radius * 0.8,
            f.y - f.radius * 0.5,
            (Math.random() - 0.5) * (drifter ? 34 : 50),
            drifter ? -40 - Math.random() * 55 : -60 - Math.random() * 80,
            drifter ? 1.7 + Math.random() * 1.1 : 0.7 + Math.random() * 0.9,
            1.5 + Math.random() * 2,
          );
          p.gravity = drifter ? -22 : 60;
          p.drag = drifter ? 0.7 : undefined;
          p.phase = drifter ? Math.random() * TAU : undefined;
          host.spawnParticle(p);
        }
      }

      if (f.intensity <= 0.02) {
        // Died — final char + a puff of smoke.
        if (host.content?.ready) {
          host.content.char(f.x, f.y, f.radius, 0.35);
        } else {
          drawScorch(host.damageCtx, f.x, f.y + 3, f.radius * 0.8, 0.15);
        }
        // Burnt through its wood: the spot smoulders — slow dim embers that
        // glow and die in place — instead of the fire just switching off.
        if (starved) {
          for (let s = 0; s < 3; s++) {
            const p = scratchParticle(
              "ember",
              f.x + (Math.random() - 0.5) * f.radius,
              f.y + (Math.random() - 0.5) * 6,
              (Math.random() - 0.5) * 6,
              -4 - Math.random() * 8,
              2.5 + Math.random() * 2.5,
              1.2 + Math.random() * 1.6,
            );
            p.gravity = -2;
            p.drag = 2.2;
            p.phase = Math.random() * TAU;
            host.spawnParticle(p);
          }
        }
        for (let s = 0; s < 4; s++) {
          const p = scratchParticle(
            "smoke",
            f.x + (Math.random() - 0.5) * f.radius,
            f.y - Math.random() * 8,
            (Math.random() - 0.5) * 15,
            -30 - Math.random() * 25,
            1.5 + Math.random(),
            7 + Math.random() * 8,
          );
          p.drag = 1.2;
          host.spawnParticle(p);
        }
        // Cooling rim: the char edge keeps glowing for a moment after the flame
        // itself is out, which is what makes the burn look hot rather than drawn.
        for (let s = 0; s < 7; s++) {
          const a = Math.random() * TAU;
          const d = f.radius * (0.55 + Math.random() * 0.45);
          const p = scratchParticle(
            "ember",
            f.x + Math.cos(a) * d,
            f.y + Math.sin(a) * d * 0.6,
            (Math.random() - 0.5) * 12,
            -6 - Math.random() * 14,
            1.1 + Math.random() * 1.4,
            1.6 + Math.random() * 2.2,
          );
          p.gravity = -4;
          p.phase = Math.random() * TAU;
          host.spawnParticle(p);
        }
        this.list.splice(i, 1);
      }
    }
  }
}
