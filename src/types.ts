export interface Vec2 {
  x: number;
  y: number;
}

export interface ToolPointerEvent {
  x: number;
  y: number;
  /** Movement delta since last event (0 on down). */
  dx: number;
  dy: number;
  buttons: number;
}

/**
 * A destruction tool. Tools are stateless where possible — persistent damage
 * goes on the engine's damage canvas, transient effects are particles/entities
 * stepped by the engine loop.
 */
export interface Tool {
  id: string;
  name: string;
  /** Emoji used for toolbar buttons and the generated cursor. */
  icon: string;
  /** Short hint shown in the toolbar ("click", "hold", "drag"). */
  hint: string;
  /** Custom CSS cursor. Falls back to crosshair. */
  cursor?: string;
  onDown?(engine: DestroyerEngineApi, e: ToolPointerEvent): void;
  onMove?(engine: DestroyerEngineApi, e: ToolPointerEvent): void;
  onUp?(engine: DestroyerEngineApi, e: ToolPointerEvent): void;
  /** Called every frame while the tool is selected. `held` = pointer down. */
  tick?(engine: DestroyerEngineApi, dt: number, held: boolean, pointer: Vec2): void;
}

export type ParticleKind =
  | "debris"
  | "spark"
  | "smoke"
  | "steam"
  | "ember"
  | "water"
  | "splash"
  | "casing"
  | "sawdust"
  | "wet"
  | "flash"
  | "shard"
  /** Pale page dust: plaster from bullet holes, sawdust haze, broom sweep. */
  | "dust"
  /** Expanding impact shockwave (hollow, so it never fills a hole back in). */
  | "ring"
  /** Rotated filament: bullet tracers and motion trails (drawn additively). */
  | "streak"
  /** The solid, still-unbroken part of the water hose's jet. */
  | "stream"
  /** Flamethrower fuel blob — the thing that makes the jet read as a cone. */
  | "jet"
  /** Water running down the page after a splash. */
  | "rivulet"
  /** Wet paint sliding downward; stamps a permanent streak where it stops. */
  | "paint"
  /** Clean twinkle left behind by the broom. */
  | "sparkle";

export interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color?: string;
  /** Secondary tint — paint drips carry their own gloss highlight. */
  color2?: string;
  spin?: number;
  angle?: number;
  gravity?: number;
  drag?: number;
  /**
   * Restitution for particles that land. Set together with `restY`: on
   * crossing it the particle bounces, loses most of its energy, and settles.
   */
  bounce?: number;
  restY?: number;
  /** Length of a "streak", and the growing tail of a "rivulet". */
  len?: number;
  /** Free-running phase for flicker/twinkle, so particles don't pulse in sync. */
  phase?: number;
  /** "shard" particles carry a chunk of the page snapshot. */
  img?: CanvasImageSource;
  sx?: number;
  sy?: number;
  sw?: number;
  sh?: number;
}

export interface Flame {
  x: number;
  y: number;
  /** 0..1 — visual + spreading strength. Water pushes it down. */
  intensity: number;
  /** Max visual radius in px. */
  radius: number;
  age: number;
  seed: number;
  /** Cooldown until this flame may spawn a child flame. */
  spreadCooldown: number;
  scorchCooldown: number;
  /** Cooldown until this flame may crack and throw a burst of embers. */
  popCooldown: number;
}

/** A source-rect handle into the pristine page snapshot (for flying shards). */
export interface ContentPatch {
  img: CanvasImageSource;
  /** Source rect in snapshot device pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export type CaptureMode = "auto" | "snapshot" | "live";

/**
 * What the capture pipeline is doing, for status UI.
 *
 * `"idle"` — no capture requested or it failed (overlay-only damage);
 * `"capturing"` — rasterization in flight; `"snapshot"`/`"live"` — ready, in
 * that mode.
 */
export type CaptureStatus = "idle" | "capturing" | "snapshot" | "live";

export interface DestroyerOptions {
  /** Element the overlay attaches to. Defaults to document.body. */
  target?: HTMLElement;
  zIndex?: number;
  soundEnabled?: boolean;
  /** Hard cap on simultaneous flames (fire spread respects this). */
  maxFlames?: number;
  maxParticles?: number;
  /**
   * Rasterize the real page into a destructible canvas so tools destroy the
   * actual content (holes reveal the void behind the page, fire burns text
   * away, repairs restore from a pristine snapshot). Default true; falls back
   * to overlay-only damage if the capture fails.
   */
  captureContent?: boolean;
  /**
   * How the page is rasterized.
   *
   * - `"auto"` (default) — use Chrome's experimental HTML-in-Canvas API
   *   (`drawElementImage`) when it is available, else the html-to-image
   *   snapshot. On any browser without the flag this is exactly the snapshot
   *   behaviour.
   * - `"snapshot"` — always html-to-image. Works everywhere; the page is frozen
   *   at activation.
   * - `"live"` — require the experimental API. If it is missing or the capture
   *   throws, warns and falls back to `"snapshot"` (see `liveUnavailable`).
   *
   * Live mode re-captures the page roughly once a second (`liveRefreshMs`)
   * while preserving destruction, so the page keeps updating underneath.
   * Requires `chrome://flags/#canvas-draw-element`. See HTML-IN-CANVAS.md.
   */
  captureMode?: CaptureMode;
  /**
   * Live mode only: how often to re-capture the un-destroyed page, in ms.
   * Default 1000. Set 0 to refresh only via `refreshContent()`.
   */
  liveRefreshMs?: number;
  /** Root element to capture/destroy. Defaults to document.body. */
  contentRoot?: HTMLElement;
  /**
   * Decides which nodes make it into the page capture. Defaults to
   * `defaultCaptureFilter`, which drops `data-dd-ignore` nodes and framework
   * dev-tooling custom elements (Next.js's indicator portal, route
   * announcers, Vite/Astro overlays, …). Replace it to capture everything, or
   * compose with the default to add your own exclusions.
   */
  captureFilter?(node: HTMLElement): boolean;
}

/** Destructive operations on the rasterized page content. */
export interface ContentApi {
  readonly ready: boolean;
  punch(x: number, y: number, r: number): void;
  burn(x: number, y: number, r: number): void;
  cut(x1: number, y1: number, x2: number, y2: number): void;
  char(x: number, y: number, r: number, alpha: number): void;
  restore(x: number, y: number, r: number): void;
  restoreAll(): void;
  /** Grab a chunk of the pristine page to fling around as a "shard" particle. */
  patch(x: number, y: number, w: number, h: number): ContentPatch | null;
}

export interface DestroyerEngineApi {
  readonly width: number;
  readonly height: number;
  readonly damageCtx: CanvasRenderingContext2D;
  /**
   * Where decals should be painted: the destructible content canvas when the
   * page capture is live, otherwise the overlay damage canvas.
   */
  readonly surfaceCtx: CanvasRenderingContext2D;
  readonly fxCtx: CanvasRenderingContext2D;
  /** Real-content destruction ops; null until the page capture is ready. */
  readonly content: ContentApi | null;
  readonly flames: Flame[];
  readonly sound: SoundApi;
  spawnParticle(p: Particle): void;
  spawnFlame(x: number, y: number, intensity?: number): void;
  /** Damp every flame within `radius` of (x, y) by `amount`. Returns hits. */
  dowseFlames(x: number, y: number, radius: number, amount: number): number;
  /** Repair damage in a circle (broom): restores content + erases overlay marks. */
  eraseDamage(x: number, y: number, radius: number): void;
  /** Blast content shards out of (x, y) — chunks of the real page fly off. */
  shatter(x: number, y: number, radius?: number): void;
  /**
   * Kick the screen. `dirX`/`dirY` add a directional lurch on top of the
   * omnidirectional rattle — an impact should shove the page away from the
   * blow, not just vibrate it.
   */
  shake(strength?: number, dirX?: number, dirY?: number): void;
  clear(): void;
  random(): number;
}

export interface SoundApi {
  enabled: boolean;
  shot(): void;
  thunk(): void;
  splat(): void;
  hiss(): void;
  /** Metallic ping of a shell casing hitting something. */
  tink(): void;
  /** Sap-pocket pop inside a fire. */
  pop(): void;
  /** Dry, brittle fracture — glass and plaster giving way. */
  crack(): void;
  /** Soft bristle sweep. */
  sweep(): void;
  /** Continuous loops keyed by name; engine calls with target gain each frame. */
  loop(name: "fire" | "water" | "saw" | "flamethrower", gain: number): void;
}

export type EngineEvent = "toolchange" | "clear" | "dispose" | "statuschange";
