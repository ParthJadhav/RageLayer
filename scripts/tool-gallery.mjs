/**
 * Captures every built-in tool against the one fixed wood surface in real
 * headless Chrome. Each isolated scenario writes a PNG plus JSON, Markdown,
 * and browsable HTML reports under artifacts/tool-gallery/.
 *
 *   node scripts/tool-gallery.mjs
 *   node scripts/tool-gallery.mjs --only laser-cutter
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluate, launchChrome, packageRoot, startStaticServer, waitFor } from "./lib/browser.mjs";

const TOOLS = [
  { id: "hammer", gesture: "hammer", settleMs: 150 },
  { id: "gun", gesture: "gun", settleMs: 150 },
  { id: "flamethrower", gesture: "flamethrower", settleMs: 0, evidence: "flamethrowerEvidence" },
  { id: "water", gesture: "water", settleMs: 0 },
  {
    id: "chainsaw",
    gesture: "chainsaw",
    settleMs: 150,
    waitFor: "__gallery.metrics().centerOpacity < 0.3",
    timeoutMs: 10_000,
  },
  { id: "paintball", gesture: "paintball", settleMs: 0 },
  {
    id: "demolition",
    gesture: "demolition",
    settleMs: 300,
    waitFor: "__gallery.metrics().removedRatio > 0",
    timeoutMs: 10_000,
  },
  {
    id: "rocket",
    gesture: "click",
    settleMs: 250,
    waitFor: "__gallery.metrics().removedRatio > 0 || __gallery.metrics().bodies > 0",
    timeoutMs: 8_000,
  },
  {
    id: "lightning",
    gesture: "click",
    settleMs: 250,
    waitFor: "__gallery.metrics().removedRatio > 0",
    timeoutMs: 10_000,
  },
  { id: "blackhole", gesture: "blackhole", settleMs: 0, captureLive: true },
  { id: "bugs", gesture: "bugs", settleMs: 300 },
  { id: "gravity-gun", gesture: "gravityGun", settleMs: 200 },
  { id: "laser-cutter", gesture: "laser", settleMs: 250 },
  { id: "acid-sprayer", gesture: "acid", settleMs: 0, evidence: "acidEvidence" },
  {
    id: "sticky-bombs",
    gesture: "click",
    settleMs: 150,
    waitFor: "__gallery.metrics().removedRatio > 0 || __gallery.metrics().bodies > 0",
    timeoutMs: 5_000,
  },
  { id: "broom", gesture: "broom", settleMs: 100 },
];
const FILTER = readFlag("--only", "").toLowerCase();
const POSTFX = !process.argv.includes("--no-postfx");
const OUTPUT_DIR = join(packageRoot, "artifacts", "tool-gallery");
const WIDTH = 960;
const HEIGHT = 720;

function readFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HARNESS = `
window.__gallery = {
  engine: window.engine,
  frame() { return new Promise((resolve) => requestAnimationFrame(resolve)); },
  async frames(count) { for (let i = 0; i < count; i++) await this.frame(); },
  event(type, x, y, buttons) {
    return new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, pointerId: 1, isPrimary: true,
      pointerType: 'mouse', button: 0, buttons,
    });
  },
  particleCount(kind) {
    return this.engine.particles.particles.filter((particle) => particle.kind === kind).length;
  },
  async select(toolId) {
    this.engine.setTool(toolId);
    await this.frames(2);
  },
  async down(point) {
    this.engine.container.dispatchEvent(this.event('pointerdown', point[0], point[1], 1));
  },
  async move(point, buttons = 1) {
    this.engine.container.dispatchEvent(this.event('pointermove', point[0], point[1], buttons));
  },
  async up(point) {
    window.dispatchEvent(this.event('pointerup', point[0], point[1], 0));
  },
  async park() {
    await this.move([850, 575], 0);
    await this.frames(3);
  },
  /** Start the clock and run the scenario, in that order and nothing between. */
  async begin(gesture, arg) {
    this.engine.resume();
    await this.frames(1);
    return arg === undefined ? this[gesture]() : this[gesture](arg);
  },
  async gesture(toolId, points, holdFrames = 3) {
    await this.select(toolId);
    const first = points[0];
    await this.down(first);
    await this.frames(holdFrames);
    for (let i = 1; i < points.length; i++) {
      await this.move(points[i]);
      await this.frames(holdFrames);
    }
    await this.up(points.at(-1));
    await this.park();
  },
  async hammer() {
    for (let i = 0; i < 6; i++) await this.gesture('hammer', [[480 + i, 350 + i]], 2);
  },
  async gun() {
    for (const x of [430, 480, 530]) await this.gesture('gun', [[x, 350]], 2);
  },
  flameRadius() {
    return Math.max(0, ...this.engine.flames.map((flame) => Math.hypot(flame.x - 480, flame.y - 365)));
  },
  opacityDamage(origin) {
    let count = 0;
    let radius = 0;
    for (let y = 160; y <= 540; y += 2) {
      for (let x = 180; x <= 780; x += 2) {
        if (this.engine.pageOpacityAt(x, y) >= 0.995) continue;
        count++;
        radius = Math.max(radius, Math.hypot(x - origin.x, y - origin.y));
      }
    }
    return { count, radius };
  },
  async flamethrower() {
    await this.select('flamethrower');
    await this.down([480, 365]);
    await this.frames(18);
    this.fireAtRelease = this.engine.flames.length;
    this.fireRadiusAtRelease = this.flameRadius();
    this.fireDamageAtRelease = this.opacityDamage({ x: 480, y: 365 });
    await this.up([480, 365]);
    await this.park();
    await this.frames(110);
    this.fireAfterSpread = this.engine.flames.length;
    this.fireRadiusAfterSpread = this.flameRadius();
    this.fireDamageAfterSpread = this.opacityDamage({ x: 480, y: 365 });
  },
  // The spread observation above intentionally outlives the visible flames.
  // Re-ignite a small patch so the evidence PNG documents both the persistent
  // damage and the live effect a visitor actually sees. Runs after the damage
  // is measured and immediately before the freeze, so nothing slow sits
  // between lighting this and photographing it.
  async flamethrowerEvidence() {
    await this.select('flamethrower');
    await this.down([540, 350]);
    await this.frames(12);
    await this.up([540, 350]);
    await this.park();
    await this.frames(3);
  },
  particleKinds() {
    const kinds = {};
    for (const particle of this.engine.particles.particles) {
      kinds[particle.kind] = (kinds[particle.kind] ?? 0) + 1;
    }
    return kinds;
  },
  /**
   * True once the captured page has actually rasterized across the working
   * area. \`engine.content\` exists before its pixels do, and a tool that
   * strikes an unpainted region finds neither structure to demolish nor
   * surface to fracture — it no-ops, and the scenario then reports damage the
   * tool was never given the chance to do.
   */
  surfaceAlphaAt(x, y) {
    const content = this.engine.content;
    if (!content) return 0;
    const d = content.dpr;
    return content.surface.getContext('2d').getImageData(
      Math.floor(x * d), Math.floor(y * d), 1, 1,
    ).data[3];
  },
  pagePainted() {
    // Opacity is the damage map, not the raster — an unpainted region still
    // reads 1 there. Ask the captured surface for its actual pixels.
    for (const point of [[270, 250], [480, 350], [660, 350], [270, 450], [660, 450]]) {
      if (this.surfaceAlphaAt(point[0], point[1]) < 200) return false;
    }
    return true;
  },
  /** What an acid reaction looks like on screen: fizz, bead and smoke. */
  reactionParticles() {
    const kinds = this.particleKinds();
    return (kinds.paint ?? 0) + (kinds.spark ?? 0) + (kinds.smoke ?? 0);
  },
  /**
   * Transient counts only, read after the engine is frozen so they describe
   * the frame that is about to be photographed rather than one from before the
   * damage scan. Everything here decays on its own; nothing in it is a
   * persistent property of the page.
   */
  liveMetrics() {
    return {
      flames: this.engine.flames.length,
      particles: this.engine.particles.count,
      particleKinds: this.particleKinds(),
      bugs: this.engine.bugs.count,
    };
  },
  surfaceDifference(bounds) {
    const content = this.engine.content;
    if (!content) return 0;
    const current = content.surface.getContext('2d').getImageData(
      0, 0, content.surface.width, content.surface.height,
    ).data;
    const d = content.dpr;
    const x0 = Math.max(0, Math.floor(bounds.x0 * d));
    const y0 = Math.max(0, Math.floor(bounds.y0 * d));
    const x1 = Math.min(content.surface.width, Math.ceil(bounds.x1 * d));
    const y1 = Math.min(content.surface.height, Math.ceil(bounds.y1 * d));
    let difference = 0;
    let samples = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const index = (y * content.surface.width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          difference += Math.abs(current[index + channel] - this.baseline[index + channel]);
          samples++;
        }
      }
    }
    return samples ? difference / (samples * 255) : 0;
  },
  async water() {
    // Two separate passes. surfaceDifference measures deviation from the
    // pristine baseline, which cannot tell a paint stain from a scorch mark —
    // a flame burning inside the measured box permanently darkens the wood and
    // reads as stain the hose failed to wash off. Wash the paint first with no
    // fire anywhere, then light one and put it out.
    // Paintball and the hose both leave the drawn tool along the same fixed
    // rest pose, up and to the left of the pointer, so firing both from one
    // spot puts the jet over exactly the stain the paint laid down. Aiming at
    // the stain instead would spray past it.
    const nozzle = [535, 395];
    const bounds = { x0: 330, y0: 170, x1: 570, y1: 410 };

    // Fire first, on bare wood. A panel that has already been painted and
    // soaked will not take a flame, so lighting one at the end tests nothing.
    // The spot is on the jet's centre line, where the extinguishing samples
    // land.
    await this.select('water');
    this.engine.spawnFlame(494, 341, 0.9);
    await this.frames(2);
    this.waterFlamesBefore = this.engine.flames.length;
    await this.down(nozzle);
    await this.frames(58);
    this.waterParticles = this.particleCount('water') + this.particleCount('stream');
    await this.up(nozzle);
    await this.park();
    this.waterFlamesAfter = this.engine.flames.length;

    // Then the paint pass. Whatever the fire scorched is present in both
    // readings below, so it cancels out and only what the hose lifts moves the
    // number.
    await this.gesture('paintball', [nozzle], 2);
    // Paint marks the surface where its droplets land, not where they are
    // fired. Measuring before they arrive reads a clean panel.
    await this.frames(45);
    this.waterStainBefore = this.surfaceDifference(bounds);
    await this.select('water');
    await this.down(nozzle);
    await this.frames(58);
    await this.up(nozzle);
    await this.park();
    this.waterStainAfter = this.surfaceDifference(bounds);
  },
  async chainsaw() {
    await this.gesture(
      'chainsaw',
      [[300, 350], [360, 350], [420, 350], [480, 350], [540, 350], [600, 350], [660, 350]],
      2,
    );
  },
  async paintball() {
    await this.select('paintball');
    await this.down([480, 350]);
    await this.frames(2);
    this.paintAtDown = this.particleCount('paint');
    await this.frames(40);
    this.paintAfterHold = this.particleCount('paint');
    await this.up([480, 350]);
    await this.park();
  },
  async demolition() {
    // Strike the empty upper-left area of the wood panel. Hitting the centered
    // label would select a tiny text node and make a successful demolition
    // look like no visible surface was removed at the gallery's sample grid.
    const point = [270, 250];
    this.preStrike = {
      opacity: this.engine.pageOpacityAt(point[0], point[1]),
      alpha: this.surfaceAlphaAt(point[0], point[1]),
      // Age of the harvested structure: it falls away from the strike point
      // once the clock runs, so a high value here means the page left before
      // the tool arrived.
      structureAge: this.engine.physics.bodies[0]?.age ?? -1,
      structureY: this.engine.physics.bodies[0]?.y ?? -1,
    };
    await this.gesture('demolition', [point], 2);
  },
  async click(toolId) {
    await this.gesture(toolId, [[480, 350]], 2);
  },
  async blackhole() {
    await this.select('blackhole');
    await this.down([480, 350]);
    await this.frames(90);
    this.blackholeRadius = this.engine.singularity?.radius ?? 0;
    this.blackholeCharge = this.engine.singularity?.charge ?? 0;
    await this.up([480, 350]);
    await this.park();
    await this.frames(12);
    const collapse = this.metrics();
    this.blackholeCollapseRemovedRatio = collapse.removedRatio;
    this.blackholeCollapseBodies = collapse.bodies;

    // Structural verification needs the collapse, but an aftermath-only PNG
    // does not show what the tool is. Reset and hold a second clean singularity
    // open so the evidence records the recognizable active effect as well.
    this.engine.clear();
    await this.frames(3);
    await this.select('blackhole');
    await this.down([480, 350]);
    await this.frames(45);
    this.blackholeEvidenceRadius = this.engine.singularity?.radius ?? 0;
  },
  async bugs() {
    for (const point of [[410, 310], [455, 390], [510, 310], [555, 390]]) {
      await this.gesture('bugs', [point], 2);
    }
  },
  async gravityGun() {
    await this.select('gravity-gun');
    await this.down([480, 350]);
    await this.frames(32);
    await this.up([480, 350]);
    await this.park();
    await this.frames(8);
  },
  async laser() {
    await this.gesture(
      'laser-cutter',
      [
        [410, 290], [480, 290], [550, 290], [550, 350], [550, 410],
        [480, 410], [410, 410], [410, 350], [410, 290],
      ],
      2,
    );
    this.laserCenterOpacity = this.engine.pageOpacityAt(480, 350);
  },
  // The drawn tool holds one fixed pose, so engine.toolAim is the constant
  // REST_AIM_X/REST_AIM_Y and no amount of pointer travel turns it. This still
  // approaches the firing point the way a visitor does, which is what keeps
  // retained cursor velocity out of the measurement.
  async primeApproach(toolId) {
    await this.select(toolId);
    // Pointer-leave is the production signal that clears retained cursor
    // velocity. Prime from a clean hover so this helper remains deterministic
    // even when it is used after parking a previous evidence pulse.
    this.engine.container.dispatchEvent(this.event('pointerleave', 0, 0, 0));
    await this.frames(2);
    await this.move([180, 350], 0);
    await this.frames(1);
    for (let x = 190; x <= 440; x += 10) {
      await this.move([x, 350], 0);
      await this.frames(1);
    }
  },
  projectedDamage(origin, aim) {
    let count = 0;
    let forwardTotal = 0;
    let minForward = Infinity;
    let maxForward = -Infinity;
    let maxSideways = 0;
    for (let y = 160; y <= 540; y += 2) {
      for (let x = 180; x <= 780; x += 2) {
        if (this.engine.pageOpacityAt(x, y) >= 0.995) continue;
        const dx = x - origin.x;
        const dy = y - origin.y;
        const forward = dx * aim.x + dy * aim.y;
        const sideways = Math.abs(-dx * aim.y + dy * aim.x);
        count++;
        forwardTotal += forward;
        minForward = Math.min(minForward, forward);
        maxForward = Math.max(maxForward, forward);
        maxSideways = Math.max(maxSideways, sideways);
      }
    }
    return {
      count,
      meanForward: count ? forwardTotal / count : 0,
      minForward: count ? minForward : 0,
      maxForward: count ? maxForward : 0,
      maxSideways,
    };
  },
  async acid() {
    await this.primeApproach('acid-sprayer');
    const origin = { x: 440, y: 350 };
    this.acidAim = { ...this.engine.toolAim };
    await this.down([origin.x, origin.y]);
    await this.frames(72);
    await this.up([origin.x, origin.y]);
    // Keep the sprayer model out of the impact corridor in the evidence PNG.
    await this.park();
    await this.frames(80);
    this.acidDamage = this.projectedDamage(origin, this.acidAim);
  },
  // The long settle above verifies the complete bounded creep. A short final
  // pulse gives the evidence image the visible fizz that tells a person *why*
  // the wood is dissolving. Sparks and smoke live for a fraction of a second,
  // so this runs after the damage scan rather than before it.
  async acidEvidence() {
    await this.primeApproach('acid-sprayer');
    const evidenceOrigin = [560, 400];
    await this.down(evidenceOrigin);
    await this.frames(16);
    await this.up(evidenceOrigin);
    await this.park();
    // Acid does not fizz on contact. The reaction particles appear as the
    // deposits age through creepAcid, so how many frames it takes for the fizz
    // to show is a function of dt, not of a frame count — waiting a fixed 16
    // frames left two sparks alive on one browser and none on the next. Run
    // until the reaction is actually on screen, then stop the clock in the
    // same turn, so the sample and the photograph are the same instant.
    for (let i = 0; i < 240 && this.reactionParticles() < 3; i++) await this.frame();
    this.engine.pause();
  },
  async broom() {
    this.engine.content?.punch(480, 350, 30);
    this.engine.markSurface(480, 350, 36);
    await this.frames(3);
    this.broomOpacityBefore = this.engine.pageOpacityAt(480, 350);
    await this.gesture(
      'broom',
      [[420, 350], [450, 350], [480, 350], [510, 350], [540, 350]],
      2,
    );
    this.broomOpacityAfter = this.engine.pageOpacityAt(480, 350);
  },
  surfaceHash() {
    const content = this.engine.content;
    if (!content) return 0;
    const d = content.dpr;
    const data = content.surface.getContext('2d').getImageData(
      180 * d, 160 * d, 600 * d, 380 * d,
    ).data;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i += 97) {
      hash = Math.imul(hash ^ data[i], 16777619) >>> 0;
    }
    return hash;
  },
  metrics() {
    let removed = 0;
    let total = 0;
    for (let y = 168; y < 532; y += 8) {
      for (let x = 188; x < 772; x += 8) {
        total++;
        if (this.engine.pageOpacityAt(x, y) < 0.3) removed++;
      }
    }
    const bodies = this.engine.physics.bodies;
    const particleKinds = this.particleKinds();

    return {
      removedRatio: total ? removed / total : 0,
      centerOpacity: this.engine.pageOpacityAt(480, 350),
      flames: this.engine.flames.length,
      particles: this.engine.particles.count,
      particleKinds,
      bugs: this.engine.bugs.count,
      bodies: bodies.length,
      averageBodySpeed: bodies.length
        ? bodies.reduce((sum, body) => sum + Math.hypot(body.vx, body.vy), 0) / bodies.length
        : 0,
      surfaceChanged: this.surfaceHash() !== this.beforeHash,
      fireAtRelease: this.fireAtRelease ?? 0,
      fireAfterSpread: this.fireAfterSpread ?? 0,
      fireRadiusAtRelease: this.fireRadiusAtRelease ?? 0,
      fireRadiusAfterSpread: this.fireRadiusAfterSpread ?? 0,
      fireDamageAtRelease: this.fireDamageAtRelease ?? { count: 0, radius: 0 },
      fireDamageAfterSpread: this.fireDamageAfterSpread ?? { count: 0, radius: 0 },
      waterParticles: this.waterParticles ?? 0,
      waterFlamesBefore: this.waterFlamesBefore ?? 0,
      waterFlamesAfter: this.waterFlamesAfter ?? 0,
      waterStainBefore: this.waterStainBefore ?? 0,
      waterStainAfter: this.waterStainAfter ?? 0,
      paintAtDown: this.paintAtDown ?? 0,
      paintAfterHold: this.paintAfterHold ?? 0,
      blackholeRadius: this.blackholeRadius ?? 0,
      blackholeCharge: this.blackholeCharge ?? 0,
      blackholeCollapseRemovedRatio: this.blackholeCollapseRemovedRatio ?? 0,
      blackholeCollapseBodies: this.blackholeCollapseBodies ?? 0,
      blackholeEvidenceRadius: this.blackholeEvidenceRadius ?? 0,
      laserCenterOpacity: this.laserCenterOpacity ?? 1,
      acidAim: this.acidAim ?? { x: 0, y: 0 },
      acidDamage: this.acidDamage ?? {
        count: 0, meanForward: 0, minForward: 0, maxForward: 0, maxSideways: 0,
      },
      preStrike: this.preStrike ?? null,
      broomOpacityBefore: this.broomOpacityBefore ?? 1,
      broomOpacityAfter: this.broomOpacityAfter ?? 0,
    };
  },
};
{
  const content = __gallery.engine.content;
  const context = content.surface.getContext('2d');
  __gallery.baseline = new Uint8ClampedArray(
    context.getImageData(0, 0, content.surface.width, content.surface.height).data,
  );
  __gallery.beforeHash = __gallery.surfaceHash();
}
true;
`;

function check(label, passed, detail) {
  return { label, passed: Boolean(passed), detail };
}

function checksFor(toolId, metrics, live) {
  const percent = (value) => `${(value * 100).toFixed(2)}%`;
  switch (toolId) {
    case "hammer":
      return [
        check(
          "Repeated hammer blows break wood",
          metrics.removedRatio > 0 || metrics.bodies > 0,
          `removed ${percent(metrics.removedRatio)}; ${metrics.bodies} bodies`,
        ),
      ];
    case "gun":
      return [
        check(
          "Bullets penetrate the wood surface",
          metrics.centerOpacity < 0.3 && metrics.removedRatio > 0,
          `center opacity ${metrics.centerOpacity.toFixed(2)}`,
        ),
      ];
    case "flamethrower":
      return [
        check(
          "The flamethrower ignites persistent fire",
          metrics.fireAtRelease > 0 && metrics.surfaceChanged,
          `${metrics.fireAtRelease} flames at release`,
        ),
        check(
          "Fire spreads after the trigger is released",
          metrics.fireDamageAfterSpread.count > metrics.fireDamageAtRelease.count &&
            metrics.fireDamageAfterSpread.radius > metrics.fireDamageAtRelease.radius + 2,
          `damaged samples ${metrics.fireDamageAtRelease.count}→${metrics.fireDamageAfterSpread.count}; radius ${metrics.fireDamageAtRelease.radius.toFixed(1)}→${metrics.fireDamageAfterSpread.radius.toFixed(1)}px`,
        ),
        check(
          "The evidence image includes live fire",
          live.flames > 0,
          `${live.flames} visible flames at capture`,
        ),
      ];
    case "water":
      return [
        check(
          "A held hose emits a continuous stream",
          metrics.waterParticles >= 6,
          `${metrics.waterParticles} live water/stream particles`,
        ),
        check(
          "Water extinguishes fire",
          metrics.waterFlamesBefore > 0 && metrics.waterFlamesAfter < metrics.waterFlamesBefore,
          `${metrics.waterFlamesBefore}→${metrics.waterFlamesAfter} flames`,
        ),
        check(
          "Water washes paint without opening a hole",
          metrics.waterStainBefore > 0 &&
            metrics.waterStainAfter < metrics.waterStainBefore &&
            metrics.removedRatio === 0,
          `stain delta ${percent(metrics.waterStainBefore)}→${percent(metrics.waterStainAfter)}`,
        ),
      ];
    case "chainsaw":
      return [
        check(
          "The chainsaw leaves a continuous structural cut",
          metrics.centerOpacity < 0.3 && metrics.removedRatio > 0,
          `center opacity ${metrics.centerOpacity.toFixed(2)}`,
        ),
      ];
    case "paintball":
      return [
        check(
          "Paintball fires repeatedly while held",
          metrics.paintAfterHold >= metrics.paintAtDown + 4,
          `${metrics.paintAtDown} paint particles after press; ${metrics.paintAfterHold} while held`,
        ),
        check(
          "Paint changes only the surviving surface",
          metrics.surfaceChanged && metrics.centerOpacity > 0.7,
          `center opacity ${metrics.centerOpacity.toFixed(2)}`,
        ),
      ];
    case "demolition":
      return [
        check(
          "Demolition removes captured page structure",
          metrics.bodies > 0 && metrics.removedRatio > 0,
          `${metrics.bodies} bodies; removed ${percent(metrics.removedRatio)}`,
        ),
      ];
    case "rocket":
      return [
        check(
          "The launched rocket returns and fractures the target",
          metrics.bodies > 0 && metrics.removedRatio > 0,
          `${metrics.bodies} bodies; removed ${percent(metrics.removedRatio)}`,
        ),
      ];
    case "lightning":
      return [
        check(
          "A grounded strike cuts and scorches wood",
          metrics.surfaceChanged && (metrics.removedRatio > 0 || metrics.bodies > 0),
          `${metrics.bodies} bodies; removed ${percent(metrics.removedRatio)}`,
        ),
      ];
    case "blackhole":
      return [
        check(
          "A held singularity charges before collapsing",
          metrics.blackholeRadius > 30 && metrics.blackholeCharge > 0.2,
          `radius ${metrics.blackholeRadius.toFixed(1)}px; charge ${metrics.blackholeCharge.toFixed(2)}`,
        ),
        check(
          "The collapse consumes wood",
          metrics.blackholeCollapseRemovedRatio > 0 || metrics.blackholeCollapseBodies > 0,
          `${metrics.blackholeCollapseBodies} bodies; removed ${percent(metrics.blackholeCollapseRemovedRatio)}`,
        ),
        check(
          "The evidence image includes a live singularity",
          metrics.blackholeEvidenceRadius > 30,
          `live radius ${metrics.blackholeEvidenceRadius.toFixed(1)}px at capture`,
        ),
      ];
    case "bugs":
      return [check("Each click releases a bug", metrics.bugs === 4, `${metrics.bugs} live bugs`)];
    case "gravity-gun":
      return [
        check(
          "The gravity gun fractures, pulls, and launches debris",
          metrics.bodies > 0 && metrics.averageBodySpeed > 10,
          `${metrics.bodies} bodies at ${metrics.averageBodySpeed.toFixed(1)}px/s average`,
        ),
      ];
    case "laser-cutter":
      return [
        check(
          "A closed laser kerf dislodges the isolated wood panel",
          metrics.bodies > 0 && metrics.laserCenterOpacity < 0.3,
          `${metrics.bodies} bodies; isolated center opacity ${metrics.laserCenterOpacity.toFixed(2)}`,
        ),
      ];
    case "acid-sprayer": {
      const damage = metrics.acidDamage;
      // `forward` is projected onto the aim the engine reported, so a positive
      // mean *is* the directional claim: the acid landed where the tool points.
      // The aim itself is the fixed `REST_AIM_X`/`REST_AIM_Y` pose — assert it
      // is a real unit vector rather than a particular compass direction, so
      // repositioning the art does not silently turn this check off.
      const aimLength = Math.hypot(metrics.acidAim.x, metrics.acidAim.y);
      return [
        check(
          "Acid lands in the visible aim direction",
          Math.abs(aimLength - 1) < 0.01 && damage.count > 0 && damage.meanForward > 5,
          `aim (${metrics.acidAim.x.toFixed(2)}, ${metrics.acidAim.y.toFixed(2)}); mean forward ${damage.meanForward.toFixed(1)}px`,
        ),
        check(
          "Acid creep remains bounded around its impact corridor",
          damage.count > 0 &&
            damage.minForward >= -19 &&
            damage.maxForward <= 48 &&
            damage.maxSideways <= 32,
          `${damage.count} samples; forward ${damage.minForward.toFixed(1)}..${damage.maxForward.toFixed(1)}px; sideways ≤${damage.maxSideways.toFixed(1)}px`,
        ),
        check(
          "The evidence image includes an active acid reaction",
          (live.particleKinds.paint ?? 0) +
            (live.particleKinds.spark ?? 0) +
            (live.particleKinds.smoke ?? 0) >
            0,
          `${live.particles} live reaction particles at capture`,
        ),
      ];
    }
    case "sticky-bombs":
      return [
        check(
          "The timed sticky bomb detonates",
          metrics.bodies > 0 && metrics.removedRatio > 0,
          `${metrics.bodies} bodies; removed ${percent(metrics.removedRatio)}`,
        ),
      ];
    case "broom":
      return [
        check(
          "The broom repairs an opened hole",
          metrics.broomOpacityBefore < 0.3 && metrics.broomOpacityAfter > 0.9,
          `center opacity ${metrics.broomOpacityBefore.toFixed(2)}→${metrics.broomOpacityAfter.toFixed(2)}`,
        ),
      ];
    default:
      return [check("Scenario completed", true, "No specialized check")];
  }
}

async function capture(cdp, sessionId, path) {
  const { data } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", fromSurface: true, optimizeForSpeed: false },
    sessionId,
  );
  await writeFile(path, Buffer.from(data, "base64"));
}

function reportMarkdown(results, browserName) {
  const lines = [
    "# RageLayer fixed-wood tool gallery",
    "",
    `Generated in ${browserName}. Every built-in tool runs in an isolated real-Chrome scenario on the same fixed wood surface.`,
    "",
    "| Tool | Result | Evidence |",
    "|---|---|---|",
  ];
  for (const result of results) {
    lines.push(
      `| ${result.tool} | ${result.passed ? "✅ PASS" : "❌ FAIL"} | [PNG](./${result.image}) |`,
    );
  }
  lines.push("", "## Assertions", "");
  for (const result of results) {
    lines.push(`### ${result.tool}`, "");
    for (const item of result.checks) {
      lines.push(`- ${item.passed ? "✅" : "❌"} ${item.label} — ${item.detail}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function galleryHtml(results, browserName) {
  const cards = results
    .map(
      (result) => `
        <figure class="card ${result.passed ? "pass" : "fail"}">
          <a href="./${result.image}"><img src="./${result.image}" alt="${escapeHtml(result.tool)} on fixed wood" loading="lazy"></a>
          <figcaption>
            <strong>${escapeHtml(result.tool)}</strong>
            <span>${result.passed ? "PASS" : "FAIL"} · ${result.checks.filter((item) => item.passed).length}/${result.checks.length} checks</span>
          </figcaption>
          <ul>${result.checks.map((item) => `<li>${item.passed ? "✅" : "❌"} ${escapeHtml(item.label)} — ${escapeHtml(item.detail)}</li>`).join("")}</ul>
        </figure>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RageLayer tool gallery</title>
<style>body{margin:0;padding:36px;background:#0b0d10;color:#f5f3ed;font:14px/1.4 system-ui}h1{margin:0}p{color:#9da3ae}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px;margin-top:28px}.card{margin:0;border:1px solid #292d35;border-radius:14px;overflow:hidden;background:#15181e}.card.fail{border-color:#e45858}.card img{display:block;width:100%;height:auto}.card figcaption{display:flex;justify-content:space-between;gap:10px;padding:12px 14px}.card span{color:#9da3ae;font-size:12px}.card ul{margin:0;padding:0 14px 14px 30px;color:#c7cad0;font-size:12px}</style></head>
<body><h1>Fixed-wood tool evidence</h1><p>${results.filter((result) => result.passed).length}/${results.length} scenarios passed · ${escapeHtml(browserName)}</p><main class="grid">${cards}</main></body></html>\n`;
}

await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });
const server = await startStaticServer("/tests/fixtures/tool-gallery.html");
const browser = await launchChrome({
  url: `${server.origin}/tests/fixtures/tool-gallery.html`,
  flags: [
    "--use-angle=swiftshader",
    "--use-gl=angle",
    "--enable-unsafe-swiftshader",
    `--window-size=${WIDTH},${HEIGHT}`,
  ],
  // `--cpu 6` reproduces a CI runner locally. Scenarios that only fail on a
  // slow machine are otherwise unreachable from a developer's desk.
  cpuRate: Number(readFlag("--cpu", "1")),
});
const { cdp, sessionId } = browser;
await cdp.send(
  "Emulation.setDeviceMetricsOverride",
  { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
  sessionId,
);
const run = (expression) => evaluate(cdp, sessionId, expression);
const errors = [];
cdp.on("Runtime.consoleAPICalled", (params) => {
  if (params.type === "error") {
    errors.push(params.args.map((arg) => arg.value ?? arg.description).join(" "));
  }
});
const results = [];

try {
  for (const tool of TOOLS) {
    if (FILTER && FILTER !== tool.id) continue;
    const url = `${server.origin}/tests/fixtures/tool-gallery.html?tool=${tool.id}&postfx=${POSTFX ? "on" : "off"}`;
    await cdp.send("Page.navigate", { url }, sessionId);
    await waitFor(cdp, sessionId, "document.documentElement?.dataset.ready === 'true'", {
      label: `${tool.id} fixture`,
    });
    await waitFor(cdp, sessionId, "window.engine?.content", {
      label: `${tool.id} capture`,
    });
    await run(HARNESS);
    // Harvested page elements fall under gravity from the moment the capture
    // completes, so the page starts leaving the coordinates every scenario
    // aims at. Stop the clock until the scenario is ready to act: measured
    // across runs, a strike 0.25s after capture lands on the structure and one
    // 8.8s later hits bare floor, because the structure is asleep at the
    // bottom of the viewport by then.
    await run("__gallery.engine.pause()");
    // Free now that nothing is moving: the capture object exists before its
    // pixels do, and a tool that strikes an unpainted region no-ops. Not
    // fatal — a scenario on a half painted page should report what it
    // measured rather than abort the suite.
    await waitFor(cdp, sessionId, "__gallery.pagePainted()", {
      timeoutMs: 10_000,
      label: `${tool.id} surface to finish painting`,
    }).catch(() => {});
    await run(
      `__gallery.begin(${JSON.stringify(tool.gesture)}${tool.gesture === "click" ? `, ${JSON.stringify(tool.id)}` : ""})`,
    );
    if (tool.waitFor) {
      // Not fatal. Surface damage is reconciled in bands across several
      // frames, so how long a structural cut takes to show up is a property of
      // the machine, not of the tool. Giving up here and measuring anyway lets
      // the scenario report what it actually saw — a checked failure with
      // numbers beats aborting the run with a timeout.
      await waitFor(cdp, sessionId, tool.waitFor, {
        timeoutMs: tool.timeoutMs,
        label: `${tool.id} interaction to complete`,
      }).catch(() => {});
    }
    await wait(tool.settleMs);
    // Persistent damage first: it has settled and only grows, so a slow
    // machine cannot change the answer.
    const metrics = await run("__gallery.metrics()");

    // Then the transient evidence, deliberately last. Sparks, smoke and flames
    // live for a fraction of a second, and `metrics()` above is a few thousand
    // opacity samples plus a round trip — producing the effect before that scan
    // meant photographing whatever survived it, which is why this suite passed
    // on one machine and not another.
    if (tool.evidence) await run(`__gallery.${tool.evidence}()`);
    if (tool.captureLive) await run("__gallery.frames(2)");
    else
      await run(
        "engine.pause(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    // Frozen: this sample and the screenshot below are the same frame.
    const live = await run("__gallery.liveMetrics()");

    const scenarioChecks = checksFor(tool.id, metrics, live);
    const passed = scenarioChecks.every((item) => item.passed);
    await run(
      `document.querySelector('#result').textContent = ${JSON.stringify(`${passed ? "PASS" : "FAIL"} · ${scenarioChecks.filter((item) => item.passed).length}/${scenarioChecks.length} checks`)}`,
    );
    const image = `${tool.id}.png`;
    await capture(cdp, sessionId, join(OUTPUT_DIR, image));
    results.push({ tool: tool.id, passed, checks: scenarioChecks, metrics, live, image });
    console.log(`  ${passed ? "ok  " : "FAIL"} ${tool.id}`);
    // On CI the JSON/PNG evidence is thrown away with the runner, so a bare
    // "FAIL chainsaw" is undiagnosable from the log alone. Print what missed.
    if (!passed) {
      for (const item of scenarioChecks.filter((check) => !check.passed)) {
        console.log(`       ✗ ${item.label} — ${item.detail}`);
      }
    }
  }

  if (results.length === 0) throw new Error(`No built-in tool matched --only ${FILTER}`);
  const report = {
    generatedAt: new Date().toISOString(),
    browser: browser.version.Browser,
    surface: "wood",
    scenarios: results.length,
    failures: results.filter((result) => !result.passed).length,
    consoleErrors: errors,
    results,
  };
  await writeFile(join(OUTPUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(OUTPUT_DIR, "README.md"), reportMarkdown(results, browser.version.Browser));
  await writeFile(join(OUTPUT_DIR, "index.html"), galleryHtml(results, browser.version.Browser));

  if (errors.length) {
    throw new Error(`Chrome logged ${errors.length} console error(s): ${errors.join(" | ")}`);
  }
  if (report.failures) throw new Error(`${report.failures} tool scenarios failed`);
  console.log(`\nAll ${results.length} fixed-wood tool scenarios passed.`);
  console.log(`Evidence: ${OUTPUT_DIR}`);
} finally {
  await browser.close();
  await server.close();
}
