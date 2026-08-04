import type {
  CaptureMode,
  CaptureStatus,
  ContentApi,
  DestroyerEngineApi,
  DestroyerOptions,
  EngineEvent,
  Flame,
  Particle,
  Tool,
  Vec2,
} from "./types";
import { SoundEngine } from "./audio";
import { ContentLayer } from "./content";
import {
  DD_IGNORE_ATTR,
  defaultCaptureFilter,
  measureCapture,
  pickPixelRatio,
  resolvePageBackdrop,
} from "./capture";
import { drawPaintStreak, drawScorch } from "./decals";
import { LiveContentSource, supportsLiveCapture } from "./live";
import { blit, blitRect, blitStreak, sprites } from "./sprites";

const TAU = Math.PI * 2;
export { DD_IGNORE_ATTR };
const MAX_CAPTURE_HEIGHT = 12000;
/** Extra margin (CSS px) drawn beyond the viewport so nothing pops at the edge. */
const FX_MARGIN = 120;

/**
 * DestroyerEngine owns the overlay DOM, the rAF loop, pointer input, and all
 * simulation state. It is framework-agnostic: the React wrapper is a thin
 * lifecycle shim around this class.
 *
 * Layer stack (bottom → top), all in document coordinates:
 * - `void` div: the dark "behind the page" backdrop revealed by holes.
 * - `content` canvas: rasterized copy of the real page (the destructible
 *   surface). While it's live the real DOM is hidden via `visibility` so
 *   layout and scrolling survive; destruction removes actual content pixels.
 * - `damage` canvas: persistent overlay decals (also the fallback surface
 *   when content capture is unavailable). Allocated lazily — in content mode
 *   nothing usually draws here, and a document-sized spare layer is expensive
 *   for the compositor even when it is empty.
 * - `fx` canvas: cleared and redrawn every frame (flames, smoke, particles,
 *   flying shards of page content). Unlike the others this one is only
 *   *viewport*-sized and rides the scroll position via a compositor-only CSS
 *   transform; particles are simulated in document coordinates and the canvas
 *   transform maps them into view.
 */
export class DestroyerEngine implements DestroyerEngineApi {
  readonly container: HTMLDivElement;
  readonly sound = new SoundEngine();
  flames: Flame[] = [];

  private voidLayer: HTMLDivElement;
  private contentLayer: ContentLayer | null = null;
  private contentRoot: HTMLElement | null = null;
  private prevRootVisibility: string | null = null;
  private damageCanvas: HTMLCanvasElement;
  private fxCanvas: HTMLCanvasElement;
  /** Viewport-parked darkening that deepens as the page gets wrecked. */
  private vignette: HTMLDivElement;
  private _damageCtx: CanvasRenderingContext2D;
  private _fxCtx: CanvasRenderingContext2D;
  /** The damage canvas only gets a backing store once something draws on it. */
  private damageReady = false;
  private particles: Particle[] = [];
  /** Round-robin slot to recycle when the particle cap is reached. */
  private recycleCursor = 0;
  /** Flat x,y pairs for splashes queued during the particle step. */
  private pendingSplashes: number[] = [];
  /** Paint drips that finished sliding this frame and owe the page a streak. */
  private pendingStamps: Particle[] = [];
  /** Per-frame render buckets, reused to keep the render path allocation-free. */
  private bucketWet: Particle[] = [];
  private bucketPuff: Particle[] = [];
  private bucketBit: Particle[] = [];
  private bucketHot: Particle[] = [];
  private tools = new Map<string, Tool>();
  private activeTool: Tool | null = null;
  private pointer: Vec2 = { x: -1000, y: -1000 };
  private lastPointer: Vec2 = { x: -1000, y: -1000 };
  private pointerDown = false;
  private raf = 0;
  private lastTime = 0;
  private shakeAmount = 0;
  /** Directional lurch and roll layered on top of the omnidirectional rattle. */
  private kickX = 0;
  private kickY = 0;
  private shakeRoll = 0;
  /**
   * 0..1 running total of how wrecked the page is, fed by every `shake()` (which
   * every destructive tool already calls, scaled by how hard it hit). Drives the
   * vignette; repairs walk it back.
   */
  private destruction = 0;
  private vignetteShown = -1;
  /** Rate gates so repeated impacts don't stack into a buzz. */
  private nextTink = 0;
  private nextHiss = 0;
  private nextPop = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  /** Viewport size the fx canvas is currently sized for. */
  private fxW = 0;
  private fxH = 0;
  private viewportH = 0;
  private fxOffsetX = -1;
  private fxOffsetY = -1;
  private vignetteOffsetX = -1;
  private vignetteOffsetY = -1;
  /** Whether the last frame put anything on the fx canvas (drives clear skips). */
  private fxPainted = false;
  /**
   * Cached scroll offset. Reading `window.scrollY` inside the render loop
   * forces a style/layout flush, because the previous frame's shake transform
   * is still pending — so it is tracked from a passive scroll listener, which
   * Chrome dispatches before rAF callbacks, instead.
   */
  private scrollX = 0;
  private scrollY = 0;
  /**
   * Document offset of the overlay container, captured without forcing layout
   * on every pointer event. See `toolEvent`.
   */
  private originX = 0;
  private originY = 0;
  private disposed = false;
  private listeners = new Map<EngineEvent, Set<() => void>>();
  private resizeTimer = 0;
  private capturing = false;
  private captureFilter: (node: HTMLElement) => boolean;
  /** Non-null only while live mode is actually in use. */
  private liveSource: LiveContentSource | null = null;
  private refreshTimer = 0;
  private refreshing = false;
  private _captureStatus: CaptureStatus = "idle";
  private _liveUnavailable = false;
  private opts: Required<
    Pick<
      DestroyerOptions,
      "zIndex" | "maxFlames" | "maxParticles" | "captureContent" | "captureMode" | "liveRefreshMs"
    >
  >;

  constructor(options: DestroyerOptions = {}) {
    this.opts = {
      zIndex: options.zIndex ?? 2147483000,
      maxFlames: options.maxFlames ?? 48,
      // Raised alongside the effects overhaul: jets, dust and rolling smoke all
      // want population, and the render path measures at a fraction of budget.
      maxParticles: options.maxParticles ?? 1400,
      captureContent: options.captureContent ?? true,
      captureMode: options.captureMode ?? "auto",
      liveRefreshMs: options.liveRefreshMs ?? 1000,
    };
    // Asked for live on a browser without the flag: record it up front so the
    // toolbar can say *why* it is in snapshot mode.
    this._liveUnavailable = this.opts.captureMode === "live" && !supportsLiveCapture();
    this.captureFilter = options.captureFilter ?? defaultCaptureFilter;
    this.sound.enabled = options.soundEnabled ?? true;
    this.contentRoot = options.contentRoot ?? document.body;

    this.container = document.createElement("div");
    this.container.setAttribute(DD_IGNORE_ATTR, "");
    Object.assign(this.container.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      zIndex: String(this.opts.zIndex),
      pointerEvents: "none",
      overflow: "hidden",
    } satisfies Partial<CSSStyleDeclaration>);

    this.voidLayer = document.createElement("div");
    Object.assign(this.voidLayer.style, {
      position: "absolute",
      inset: "0",
      display: "none",
      background:
        "radial-gradient(ellipse 120% 60% at 50% 0%, #17130f 0%, #0c0a08 55%, #060504 100%)",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.voidLayer);

    this.damageCanvas = document.createElement("canvas");
    this.fxCanvas = document.createElement("canvas");
    for (const c of [this.damageCanvas, this.fxCanvas]) {
      Object.assign(c.style, {
        position: "absolute",
        top: "0",
        left: "0",
      } satisfies Partial<CSSStyleDeclaration>);
      this.container.appendChild(c);
    }
    // Start the damage canvas at zero size rather than the 300×150 default —
    // `ensureDamage` gives it a backing store the first time anything draws.
    this.damageCanvas.width = 0;
    this.damageCanvas.height = 0;
    // The fx canvas is re-drawn every frame and only ever shows the viewport,
    // so it is promoted to its own compositor layer and scrolled by transform.
    Object.assign(this.fxCanvas.style, {
      willChange: "transform",
      transformOrigin: "0 0",
    } satisfies Partial<CSSStyleDeclaration>);

    // Global "this page has been through something" darkening. A CSS gradient
    // on its own compositor layer, parked over the viewport exactly like the fx
    // canvas: no per-frame canvas fill, and it only ever animates `opacity`.
    this.vignette = document.createElement("div");
    Object.assign(this.vignette.style, {
      position: "absolute",
      top: "0",
      left: "0",
      opacity: "0",
      pointerEvents: "none",
      transformOrigin: "0 0",
      willChange: "opacity, transform",
      transition: "opacity 0.6s ease-out",
      background:
        "radial-gradient(ellipse 76% 70% at 50% 50%, rgba(0,0,0,0) 32%, rgba(0,0,0,0.45) 74%, rgba(0,0,0,0.88) 100%)",
    } satisfies Partial<CSSStyleDeclaration>);
    this.container.appendChild(this.vignette);
    this._damageCtx = this.damageCanvas.getContext("2d")!;
    // `desynchronized` lets the compositor take fx frames without round-tripping
    // through the main thread's commit. Nothing reads pixels back from fx.
    // Measured: ~15% off GPU-process time in the fire-heavy trace.
    this._fxCtx = this.fxCanvas.getContext("2d", { desynchronized: true })!;

    (options.target ?? document.body).appendChild(this.container);
    this.resize();
    this.onScroll();
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("scroll", this.onScroll, { passive: true });

    this.container.addEventListener("pointerdown", this.onPointerDown);
    this.container.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.container.addEventListener("pointerleave", this.onPointerLeave);
    this.container.addEventListener("contextmenu", this.onContextMenu);

    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.frame);

    if (this.opts.captureContent) {
      void this.captureContent();
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get width() {
    return this.w;
  }
  get height() {
    return this.h;
  }
  get damageCtx() {
    this.ensureDamage();
    return this._damageCtx;
  }
  get fxCtx() {
    return this._fxCtx;
  }
  get surfaceCtx() {
    if (this.contentLayer?.ready) return this.contentLayer.ctx;
    this.ensureDamage();
    return this._damageCtx;
  }
  get content(): ContentApi | null {
    return this.contentLayer?.ready ? this.contentLayer : null;
  }

  /**
   * What the capture pipeline is doing. Changes fire a `"statuschange"` event,
   * which is what the toolbar's status chip listens to.
   */
  get captureStatus(): CaptureStatus {
    return this._captureStatus;
  }

  /** Live mode was requested but the experimental API isn't available. */
  get liveUnavailable(): boolean {
    return this._liveUnavailable;
  }

  /** The mode that was asked for (not necessarily the one in use). */
  get captureMode(): CaptureMode {
    return this.opts.captureMode;
  }

  /**
   * Live mode: re-capture the page now, keeping every wound. No-op in snapshot
   * mode, or while a capture/refresh is already in flight.
   */
  refreshContent(): Promise<void> {
    return this.refreshLive();
  }

  registerTool(tool: Tool) {
    this.tools.set(tool.id, tool);
  }

  getTools(): Tool[] {
    return [...this.tools.values()];
  }

  get tool(): Tool | null {
    return this.activeTool;
  }

  setTool(id: string | null) {
    const next = id ? (this.tools.get(id) ?? null) : null;
    if (next === this.activeTool) return;
    if (this.pointerDown && this.activeTool?.onUp) {
      this.activeTool.onUp(this, { ...this.pointer, dx: 0, dy: 0, buttons: 0 });
    }
    this.pointerDown = false;
    this.activeTool = next;
    this.container.style.pointerEvents = next ? "auto" : "none";
    this.container.style.cursor = next ? (next.cursor ?? "crosshair") : "";
    this.container.style.touchAction = next ? "none" : "";
    this.emit("toolchange");
  }

  clear() {
    if (this.damageReady) this._damageCtx.clearRect(0, 0, this.w, this.h);
    this.contentLayer?.restoreAll();
    this.flames = [];
    this.particles.length = 0;
    this.destruction = 0;
    this.emit("clear");
  }

  setSound(enabled: boolean) {
    this.sound.enabled = enabled;
    if (!enabled) {
      this.sound.loop("fire", 0);
      this.sound.loop("water", 0);
      this.sound.loop("saw", 0);
      this.sound.loop("flamethrower", 0);
    }
  }

  on(event: EngineEvent, cb: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.refreshTimer);
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("scroll", this.onScroll);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.container.removeEventListener("contextmenu", this.onContextMenu);
    this.exitContentMode();
    this.contentLayer?.dispose();
    this.contentLayer = null;
    this.liveSource?.dispose();
    this.liveSource = null;
    this.setStatus("idle");
    this.container.remove();
    this.sound.dispose();
    this.emit("dispose");
    this.listeners.clear();
  }

  // ── Content capture (the "destroy the real page" pipeline) ────────────────

  private setStatus(status: CaptureStatus) {
    if (this._captureStatus === status) return;
    this._captureStatus = status;
    this.emit("statuschange");
  }

  private async captureContent() {
    if (this.capturing || this.disposed || !this.contentRoot) return;
    this.capturing = true;
    this.setStatus("capturing");
    try {
      const layer = this.contentLayer ?? new ContentLayer();
      this.contentLayer = layer;
      // Match the overlay's own geometry so the destructible surface, the void
      // and the fx canvas share one coordinate space.
      const doc = this.docSize();
      const geometry = measureCapture(this.contentRoot, doc.width, doc.height, MAX_CAPTURE_HEIGHT);
      const backdrop = resolvePageBackdrop(this.contentRoot);

      let live = false;
      if (this.opts.captureMode !== "snapshot" && supportsLiveCapture()) {
        try {
          await this.captureLive(layer, geometry, backdrop);
          live = true;
        } catch (err) {
          // "live" was best-effort or explicit; either way a working toy beats
          // a broken one, so drop to the snapshot path.
          if (this.opts.captureMode === "live") {
            this._liveUnavailable = true;
            console.warn(
              "[desktop-destroyer] live capture failed, falling back to snapshot mode:",
              err,
            );
          }
        }
      }
      if (this.disposed) return;

      if (!live) {
        layer.live = false;
        await layer.capture(this.contentRoot, geometry.width, geometry.height, this.captureFilter, {
          source: geometry.source,
          rootSize: geometry.rootSize,
          backdrop,
        });
        if (this.disposed) return;
        this.liveSource?.dispose();
        this.liveSource = null;
      }

      // Content canvas sits between the void backdrop and the damage canvas.
      this.container.insertBefore(layer.canvas, this.damageCanvas);
      this.enterContentMode();
      this.setStatus(live ? "live" : "snapshot");
      if (live) this.scheduleRefresh();
    } catch (err) {
      // Capture can fail (e.g. CORS-tainted resources). Fall back to
      // overlay-only damage rather than breaking the toy.
      console.warn("[desktop-destroyer] page capture failed, using overlay mode:", err);
      this.contentLayer?.dispose();
      this.contentLayer = null;
      this.setStatus("idle");
    } finally {
      this.capturing = false;
    }
  }

  /** First live capture: raster the page through `drawElementImage`. */
  private async captureLive(
    layer: ContentLayer,
    geometry: ReturnType<typeof measureCapture>,
    backdrop: ReturnType<typeof resolvePageBackdrop>,
  ) {
    const source = (this.liveSource ??= new LiveContentSource());
    layer.dpr = pickPixelRatio(geometry.width, geometry.height);
    const raster = await source.capture(
      this.contentRoot!,
      geometry.width,
      geometry.height,
      layer.dpr,
      { source: geometry.source, rootSize: geometry.rootSize, backdrop, filter: this.captureFilter },
    );
    if (this.disposed) throw new Error("disposed");
    // Set before adopt: `adopt` resets the wound buffers, and `live` decides
    // whether damage is recorded into them at all.
    layer.live = true;
    layer.adopt(raster, geometry.width, geometry.height);
  }

  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (this.opts.liveRefreshMs <= 0 || this.disposed) return;
    this.refreshTimer = window.setTimeout(() => {
      void this.refreshLive().then(() => this.scheduleRefresh());
    }, this.opts.liveRefreshMs);
  }

  /**
   * Re-capture the un-destroyed page into the layer's base while keeping every
   * wound. Cheap (~6 ms on a typical page) because it is one `drawElementImage`
   * rather than an SVG round-trip — which is the whole point of live mode.
   */
  private async refreshLive() {
    const layer = this.contentLayer;
    if (!this.liveSource || !layer?.ready || !layer.live) return;
    if (this.refreshing || this.capturing || this.disposed || !this.contentRoot) return;
    // A hidden tab still runs timers but its rAF is throttled to a crawl, and
    // the capture awaits two frames. Skip rather than pile up.
    if (document.hidden) return;
    this.refreshing = true;
    try {
      const doc = this.docSize();
      const geometry = measureCapture(this.contentRoot, doc.width, doc.height, MAX_CAPTURE_HEIGHT);
      // A reflow invalidates the whole capture; the resize handler owns that.
      if (geometry.width !== layer.width || geometry.height !== layer.height) return;
      const raster = await this.liveSource.capture(
        this.contentRoot,
        geometry.width,
        geometry.height,
        layer.dpr,
        {
          source: geometry.source,
          rootSize: geometry.rootSize,
          backdrop: resolvePageBackdrop(this.contentRoot),
          filter: this.captureFilter,
        },
      );
      if (this.disposed) return;
      layer.refreshBase(raster);
    } catch (err) {
      // A failed refresh just means the base is a little stale — the existing
      // pixels and all the destruction are still on screen. Stop retrying.
      console.warn("[desktop-destroyer] live refresh failed, keeping last capture:", err);
      clearTimeout(this.refreshTimer);
      this.opts.liveRefreshMs = 0;
    } finally {
      this.refreshing = false;
    }
  }

  private enterContentMode() {
    if (!this.contentRoot || !this.contentLayer?.ready) return;
    if (this.prevRootVisibility === null) {
      this.prevRootVisibility = this.contentRoot.style.visibility;
    }
    // Hide the real DOM but keep its layout (scrollbars, page height). Our
    // own container un-hides itself — visibility, unlike display, can be
    // re-enabled on descendants.
    this.contentRoot.style.visibility = "hidden";
    this.container.style.visibility = "visible";
    this.voidLayer.style.display = "block";
  }

  private exitContentMode() {
    if (this.contentRoot && this.prevRootVisibility !== null) {
      this.contentRoot.style.visibility = this.prevRootVisibility;
      this.prevRootVisibility = null;
    }
    this.voidLayer.style.display = "none";
  }

  // ── DestroyerEngineApi (used by tools) ────────────────────────────────────

  random() {
    return Math.random();
  }

  spawnParticle(p: Particle) {
    if (this.particles.length >= this.opts.maxParticles) {
      // At the cap, recycle a slot round-robin instead of `shift()`-ing the
      // array (which memmoves every remaining particle, on every spawn, at the
      // exact moment the system is already saturated). Render order is decided
      // by particle kind, not array order, so the swap is invisible.
      this.recycleCursor = (this.recycleCursor + 1) % this.particles.length;
      this.particles[this.recycleCursor] = p;
      return;
    }
    this.particles.push(p);
  }

  spawnFlame(x: number, y: number, intensity = 0.35) {
    // Merge into a nearby flame instead of stacking duplicates.
    for (const f of this.flames) {
      if (Math.hypot(f.x - x, f.y - y) < f.radius * 0.6) {
        f.intensity = Math.min(1, f.intensity + intensity * 0.5);
        return;
      }
    }
    if (this.flames.length >= this.opts.maxFlames) return;
    this.flames.push({
      x,
      y,
      intensity,
      radius: 17 + Math.random() * 21,
      age: 0,
      seed: Math.random() * 1000,
      spreadCooldown: 1.5 + Math.random() * 2,
      scorchCooldown: 0.4,
      popCooldown: 1 + Math.random() * 3,
    });
  }

  dowseFlames(x: number, y: number, radius: number, amount: number): number {
    let hits = 0;
    for (const f of this.flames) {
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
        hits++;
        if (Math.random() < 0.4) {
          // Quenching steam boils *upward and outward* off the flame, so it gets
          // real lateral spread rather than the near-vertical wisp it had.
          this.spawnParticle({
            kind: "steam",
            x: f.x + (Math.random() - 0.5) * f.radius * 1.4,
            y: f.y - Math.random() * 10,
            vx: (Math.random() - 0.5) * 90,
            vy: -70 - Math.random() * 90,
            life: 0,
            maxLife: 1 + Math.random() * 1.1,
            size: 10 + Math.random() * 18,
            drag: 1.4,
          });
        }
      }
    }
    // The hiss belongs to the *event* of water meeting fire, not to each of the
    // hundred droplet/flame pairs that can register in a single frame.
    if (hits > 0 && this.lastTime > this.nextHiss) {
      this.nextHiss = this.lastTime + 260;
      this.sound.hiss();
    }
    return hits;
  }

  eraseDamage(x: number, y: number, radius: number) {
    // Sweeping is the one thing that un-wrecks the page, so it walks the
    // vignette back too.
    this.destruction = Math.max(0, this.destruction - 0.004);
    // Repair the real content from the pristine snapshot...
    this.contentLayer?.restore(x, y, radius);
    // ...and sweep any overlay decals (also the fallback path). Nothing to
    // sweep if the damage canvas was never painted on.
    if (!this.damageReady) return;
    const ctx = this._damageCtx;
    ctx.globalCompositeOperation = "destination-out";
    blit(ctx, sprites().erase, x, y, radius, 1);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Knock chunks of real page content loose: hole + tumbling shards. */
  shatter(x: number, y: number, radius = 26) {
    const layer = this.contentLayer;
    if (!layer?.ready) return;
    const shards = 11 + Math.floor(Math.random() * 7);
    for (let i = 0; i < shards; i++) {
      const size = 6 + Math.random() * radius * 0.75;
      const patch = layer.patch(
        x + (Math.random() - 0.5) * radius * 1.4,
        y + (Math.random() - 0.5) * radius * 1.4,
        size,
        size,
      );
      if (!patch) continue;
      const a = Math.random() * TAU;
      const speed = 110 + Math.random() * 340;
      this.spawnParticle({
        kind: "shard",
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 200,
        life: 0,
        maxLife: 1.3 + Math.random() * 0.9,
        size,
        angle: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 26,
        // Shards fall out of the page and clatter onto whatever is below it.
        bounce: 0.42 + Math.random() * 0.2,
        restY: y + 70 + Math.random() * 220,
        img: patch.img,
        sx: patch.sx,
        sy: patch.sy,
        sw: patch.sw,
        sh: patch.sh,
      });
    }
    layer.punch(x, y, radius * 0.8);
  }

  shake(strength = 6, dirX = 0, dirY = 0) {
    this.shakeAmount = Math.max(this.shakeAmount, strength);
    if (dirX !== 0 || dirY !== 0) {
      const mag = Math.hypot(dirX, dirY) || 1;
      this.kickX += (dirX / mag) * strength * 0.5;
      this.kickY += (dirY / mag) * strength * 0.5;
    }
    // A little roll on every hit: pure translation reads as a rattle, a tilt
    // reads as the page taking the blow.
    this.shakeRoll += (Math.random() - 0.5) * strength * 0.00035;
    // Every destructive tool already calls shake(), scaled by how hard it hit —
    // which makes it the one honest measure of accumulated damage.
    this.destruction = Math.min(1, this.destruction + strength * 0.0012);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private emit(event: EngineEvent) {
    this.listeners.get(event)?.forEach((cb) => cb());
  }

  private docSize() {
    return {
      width: document.documentElement.clientWidth,
      height: Math.min(
        Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
        MAX_CAPTURE_HEIGHT,
      ),
    };
  }

  /**
   * Give the damage canvas a real backing store. Deferred until something
   * actually paints on it: with the page capture live every tool draws onto
   * the content canvas instead, and an empty document-sized layer still costs
   * the compositor a full set of tiles.
   */
  private ensureDamage() {
    if (this.damageReady || this.w === 0) return;
    this.damageReady = true;
    this.damageCanvas.width = Math.round(this.w * this.dpr);
    this.damageCanvas.height = Math.round(this.h * this.dpr);
    this.damageCanvas.style.width = `${this.w}px`;
    this.damageCanvas.style.height = `${this.h}px`;
    this._damageCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Keep the fx canvas matched to the viewport (not the document). */
  private resizeFx() {
    const width = document.documentElement.clientWidth;
    this.viewportH = window.innerHeight;
    const height = Math.min(this.viewportH + FX_MARGIN * 2, this.h + FX_MARGIN * 2);
    this.vignette.style.width = `${width}px`;
    this.vignette.style.height = `${this.viewportH}px`;
    if (width === this.fxW && height === this.fxH) return;
    this.fxW = width;
    this.fxH = height;
    this.fxCanvas.width = Math.round(width * this.dpr);
    this.fxCanvas.height = Math.round(height * this.dpr);
    this.fxCanvas.style.width = `${width}px`;
    this.fxCanvas.style.height = `${height}px`;
    // Force the transform to be re-applied against the new size.
    this.fxOffsetX = this.fxOffsetY = -1;
  }

  private resize() {
    const { width, height } = this.docSize();
    if (width === 0 || height === 0) return;
    const dpr = pickPixelRatio(width, height);
    if (width === this.w && height === this.h && dpr === this.dpr) {
      this.resizeFx();
      return;
    }

    // Preserve existing damage across resizes (top-left anchored). Only
    // meaningful once the damage canvas has actually been allocated — an
    // untouched one has no pixels worth carrying over.
    let prev: HTMLCanvasElement | null = null;
    const prevDpr = this.dpr;
    if (this.damageReady) {
      prev = document.createElement("canvas");
      prev.width = this.damageCanvas.width;
      prev.height = this.damageCanvas.height;
      prev.getContext("2d")!.drawImage(this.damageCanvas, 0, 0);
    }

    this.w = width;
    this.h = height;
    this.dpr = dpr;
    this.container.style.height = `${height}px`;
    this.measureOrigin();
    this.resizeFx();

    if (prev) {
      this.damageReady = false;
      this.ensureDamage();
      this._damageCtx.drawImage(prev, 0, 0, prev.width / prevDpr, prev.height / prevDpr);
    }
  }

  private onScroll = () => {
    this.scrollX = window.scrollX;
    this.scrollY = window.scrollY;
  };

  private onWindowResize = () => {
    this.onScroll();
    this.resize();
    // A width change invalidates the page capture (text reflows). Debounce a
    // fresh capture; the old one keeps showing until the new one lands.
    if (this.contentLayer?.ready) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        if (this.disposed || !this.contentLayer) return;
        if (this.contentLayer.width !== document.documentElement.clientWidth) {
          clearTimeout(this.refreshTimer);
          this.exitContentMode();
          this.contentLayer.ready = false;
          void this.captureContent();
        }
      }, 350);
    }
  };

  /**
   * Document-space position of the overlay container.
   *
   * Read via the `offsetParent` chain rather than `getBoundingClientRect` for
   * two reasons: it can be cached across pointer events (the container's
   * document anchor only moves on resize), and it ignores the shake transform,
   * which would otherwise make the cursor's hit position jitter along with the
   * screen shake.
   */
  private measureOrigin() {
    let x = 0;
    let y = 0;
    let el: HTMLElement | null = this.container;
    while (el) {
      x += el.offsetLeft;
      y += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }
    this.originX = x;
    this.originY = y;
  }

  private toolEvent(e: PointerEvent) {
    // Equivalent to `clientX - container.getBoundingClientRect().left`, but
    // without forcing a layout on every pointermove.
    const x = e.clientX + window.scrollX - this.originX;
    const y = e.clientY + window.scrollY - this.originY;
    const ev = {
      x,
      y,
      dx: this.lastPointer.x < -100 ? 0 : x - this.lastPointer.x,
      dy: this.lastPointer.y < -100 ? 0 : y - this.lastPointer.y,
      buttons: e.buttons,
    };
    this.lastPointer = { x, y };
    this.pointer = { x, y };
    return ev;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (!this.activeTool || e.button !== 0) return;
    e.preventDefault();
    this.pointerDown = true;
    this.lastPointer = { x: -1000, y: -1000 };
    // Always build the event (it updates this.pointer for tick-driven tools),
    // even when the tool has no onDown handler.
    const ev = this.toolEvent(e);
    this.activeTool.onDown?.(this, ev);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.activeTool) return;
    const ev = this.toolEvent(e);
    this.activeTool.onMove?.(this, ev);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointerDown) return;
    this.pointerDown = false;
    const ev = this.toolEvent(e);
    this.activeTool?.onUp?.(this, ev);
  };

  private onPointerLeave = () => {
    this.pointer = { x: -1000, y: -1000 };
    this.lastPointer = { x: -1000, y: -1000 };
  };

  private onContextMenu = (e: Event) => {
    if (this.activeTool) e.preventDefault();
  };

  private frame = (now: number) => {
    if (this.disposed) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.activeTool?.tick?.(this, dt, this.pointerDown, this.pointer);
    this.stepFlames(dt);
    this.stepParticles(dt);
    this.render();
    this.updateShake(dt);
    this.updateVignette();
    this.updateLoops();

    this.raf = requestAnimationFrame(this.frame);
  };

  private stepFlames(dt: number) {
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const f = this.flames[i];
      f.age += dt;
      // Young flames grow toward full intensity; old ones slowly starve.
      const target = f.age < 12 ? 1 : 0;
      f.intensity += (target - f.intensity) * dt * (f.age < 12 ? 0.35 : 0.08);

      // Fire consumes the page: erode content pixels and char the rim.
      f.scorchCooldown -= dt;
      if (f.scorchCooldown <= 0 && f.intensity > 0.15) {
        // Jittered rather than a flat 0.3s: with a fixed period every flame
        // lit in the same frame stays in lockstep forever, so all of them
        // repaint the (document-sized) content canvas on the same frame.
        f.scorchCooldown = 0.26 + Math.random() * 0.14;
        if (this.contentLayer?.ready) {
          this.contentLayer.burn(f.x, f.y + 2, f.radius * (0.25 + f.intensity * 0.35));
        } else {
          drawScorch(
            this.damageCtx,
            f.x + (Math.random() - 0.5) * 8,
            f.y + 4 + (Math.random() - 0.5) * 6,
            f.radius * (0.5 + f.intensity * 0.5),
            0.05 + f.intensity * 0.06,
          );
        }
      }

      // Fire spreads: strong flames seed children nearby.
      f.spreadCooldown -= dt;
      if (f.spreadCooldown <= 0 && f.intensity > 0.75 && this.flames.length < this.opts.maxFlames) {
        f.spreadCooldown = 2 + Math.random() * 3;
        const angle = Math.random() * TAU;
        const dist = f.radius * (1.2 + Math.random());
        const nx = f.x + Math.cos(angle) * dist;
        const ny = f.y + Math.sin(angle) * dist * 0.6;
        if (nx > 0 && nx < this.w && ny > 0 && ny < this.h) {
          this.spawnFlame(nx, ny, 0.25);
        }
      }

      // Sap-pocket pops: an audible crack that throws a fistful of embers, so a
      // sustained fire keeps startling you instead of settling into wallpaper.
      f.popCooldown -= dt;
      if (f.popCooldown <= 0 && f.intensity > 0.55) {
        f.popCooldown = 1.8 + Math.random() * 4;
        for (let s = 0; s < 5 + Math.floor(Math.random() * 5); s++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
          const speed = 110 + Math.random() * 220;
          this.spawnParticle({
            kind: "ember",
            x: f.x,
            y: f.y - f.radius * 0.4,
            vx: Math.cos(a) * speed,
            vy: Math.sin(a) * speed,
            life: 0,
            maxLife: 0.7 + Math.random() * 0.8,
            size: 1.8 + Math.random() * 2.6,
            gravity: 130,
            drag: 1.1,
          });
        }
        if (this.lastTime > this.nextPop) {
          this.nextPop = this.lastTime + 280;
          this.sound.pop();
        }
      }

      // Smoke + embers. Rates are per *second* and scaled by dt: as per-frame
      // probabilities they doubled on a 120Hz display, which is exactly where
      // the frame budget is already halved — the particle cap then sat pinned
      // and every extra puff was overdraw nobody asked for.
      if (f.intensity > 0.2) {
        if (Math.random() < f.intensity * 34 * dt) {
          // Rolling column: puffs are launched hard, then dragged to a crawl, so
          // they bunch up and billow overhead instead of streaming away as dots.
          this.spawnParticle({
            kind: "smoke",
            x: f.x + (Math.random() - 0.5) * f.radius,
            y: f.y - f.radius * 0.9,
            vx: (Math.random() - 0.5) * 55,
            vy: -70 - Math.random() * 90 * f.intensity,
            life: 0,
            maxLife: 2.4 + Math.random() * 2.6,
            size: 9 + Math.random() * 16 * f.intensity,
            gravity: -18,
            drag: 1.5,
            spin: (Math.random() - 0.5) * 1.2,
            angle: Math.random() * TAU,
            phase: Math.random() * TAU,
          });
        }
        if (Math.random() < f.intensity * 9 * dt) {
          this.spawnParticle({
            kind: "ember",
            x: f.x + (Math.random() - 0.5) * f.radius * 0.8,
            y: f.y - f.radius * 0.5,
            vx: (Math.random() - 0.5) * 50,
            vy: -60 - Math.random() * 80,
            life: 0,
            maxLife: 0.7 + Math.random() * 0.9,
            size: 1.5 + Math.random() * 2,
            gravity: 60,
          });
        }
      }

      if (f.intensity <= 0.02) {
        // Died — final char + a puff of smoke.
        if (this.contentLayer?.ready) {
          this.contentLayer.char(f.x, f.y, f.radius, 0.35);
        } else {
          drawScorch(this.damageCtx, f.x, f.y + 3, f.radius * 0.8, 0.15);
        }
        for (let s = 0; s < 4; s++) {
          this.spawnParticle({
            kind: "smoke",
            x: f.x + (Math.random() - 0.5) * f.radius,
            y: f.y - Math.random() * 8,
            vx: (Math.random() - 0.5) * 15,
            vy: -30 - Math.random() * 25,
            life: 0,
            maxLife: 1.5 + Math.random(),
            size: 7 + Math.random() * 8,
            drag: 1.2,
          });
        }
        // Cooling rim: the char edge keeps glowing for a moment after the flame
        // itself is out, which is what makes the burn look hot rather than drawn.
        for (let s = 0; s < 7; s++) {
          const a = Math.random() * TAU;
          const d = f.radius * (0.55 + Math.random() * 0.45);
          this.spawnParticle({
            kind: "ember",
            x: f.x + Math.cos(a) * d,
            y: f.y + Math.sin(a) * d * 0.6,
            vx: (Math.random() - 0.5) * 12,
            vy: -6 - Math.random() * 14,
            life: 0,
            maxLife: 1.1 + Math.random() * 1.4,
            size: 1.6 + Math.random() * 2.2,
            gravity: -4,
          });
        }
        this.flames.splice(i, 1);
      }
    }
  }

  private stepParticles(dt: number) {
    // Single compaction pass: survivors are written down over dead particles,
    // so removing hundreds of expiring droplets a second costs one linear walk
    // instead of a `splice` (O(n) memmove) per death.
    const list = this.particles;
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life += dt;
      if (p.life >= p.maxLife) {
        // A drip that has stopped moving leaves a permanent run on the page.
        // Queued, not stamped here: the content canvas is document-sized and
        // this pass is already the hot loop.
        if (p.kind === "paint") this.pendingStamps.push(p);
        continue;
      }

      const gravity = p.gravity ?? (p.kind === "smoke" || p.kind === "steam" || p.kind === "dust" ? -10 : 350);
      p.vy += gravity * dt;
      if (p.drag) {
        p.vx *= 1 - p.drag * dt;
        p.vy *= 1 - p.drag * dt;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.angle !== undefined && p.spin) p.angle += p.spin * dt;
      // Runs trail behind whatever is sliding down the page — water rivulets
      // and paint drips both leave a tail as long as the distance they covered.
      if (p.kind === "rivulet" || p.kind === "paint") p.len = (p.len ?? 0) + Math.max(0, p.vy) * dt;

      // Landing. Solid bits fall out of the page and clatter onto whatever is
      // below; settling them (rather than letting them sink forever) is most of
      // what makes debris read as physical.
      if (p.bounce && p.restY !== undefined && p.vy > 0 && p.y >= p.restY) {
        p.y = p.restY;
        p.vy = -p.vy * p.bounce;
        p.vx *= 0.55;
        if (p.spin) p.spin *= 0.4;
        if (p.kind === "casing" && p.bounce > 0.35 && this.lastTime > this.nextTink) {
          this.nextTink = this.lastTime + 45;
          this.sound.tink();
        }
        p.bounce *= 0.42;
        if (p.bounce < 0.12) {
          p.bounce = 0;
          p.vx = p.vy = 0;
          p.gravity = 0;
          p.spin = 0;
        }
      }

      // Water droplets extinguish flames they touch.
      if (p.kind === "water") {
        if (this.flames.length > 0 && this.dowseFlames(p.x, p.y, 10, 0.12) > 0) continue;
        // Splash when a droplet "lands" (end of its arc). Deferred: spawning
        // mid-compaction could land a new particle in a slot this pass has
        // already walked past.
        if (p.life > p.maxLife * 0.85) {
          this.pendingSplashes.push(p.x, p.y);
          continue;
        }
      }
      list[write++] = p;
    }
    list.length = write;
    if (this.recycleCursor >= write) this.recycleCursor = 0;

    for (let i = 0; i < this.pendingSplashes.length; i += 2) {
      this.spawnSplash(this.pendingSplashes[i], this.pendingSplashes[i + 1]);
    }
    this.pendingSplashes.length = 0;

    if (this.pendingStamps.length > 0) {
      const ctx = this.surfaceCtx;
      for (const p of this.pendingStamps) {
        drawPaintStreak(ctx, p.x, p.y, p.len ?? 8, p.size, p.color ?? "#e63946", p.color2);
      }
      this.pendingStamps.length = 0;
    }
  }

  private spawnSplash(x: number, y: number) {
    for (let i = 0; i < 3; i++) {
      this.spawnParticle({
        kind: "splash",
        x,
        y,
        vx: (Math.random() - 0.5) * 90,
        vy: -Math.random() * 70,
        life: 0,
        maxLife: 0.25 + Math.random() * 0.2,
        size: 1 + Math.random() * 2,
      });
    }
    // Lingering wet mark.
    this.spawnParticle({
      kind: "wet",
      x,
      y,
      vx: 0,
      vy: 12,
      life: 0,
      maxLife: 2.5 + Math.random() * 2,
      size: 5 + Math.random() * 9,
      gravity: 0,
    });
    // Every few splashes, one gathers into a run that streaks down the page.
    if (Math.random() < 0.22) {
      this.spawnParticle({
        kind: "rivulet",
        x,
        y,
        vx: (Math.random() - 0.5) * 8,
        vy: 30 + Math.random() * 50,
        life: 0,
        maxLife: 1.1 + Math.random() * 1.2,
        size: 1.4 + Math.random() * 1.8,
        gravity: 90,
        drag: 1.6,
        len: 0,
      });
    }
  }

  /**
   * Park the (viewport-sized) fx canvas over the visible band and set up a
   * matching drawing transform, so the rest of the renderer keeps working in
   * document coordinates. Returns the visible document band for culling.
   */
  private positionFx() {
    const left = Math.max(0, this.scrollX);
    const top = Math.max(0, this.scrollY - FX_MARGIN);
    if (left !== this.fxOffsetX || top !== this.fxOffsetY) {
      this.fxOffsetX = left;
      this.fxOffsetY = top;
      // A transform (not `top`/`left`) so scrolling never re-rasters the layer.
      this.fxCanvas.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }
    // The vignette tracks the viewport itself, not the fx band, so it needs its
    // own offset — `top` is clamped at the top of the document and would stick.
    const vTop = Math.max(0, Math.min(this.scrollY, this.h - this.viewportH));
    if (left !== this.vignetteOffsetX || vTop !== this.vignetteOffsetY) {
      this.vignetteOffsetX = left;
      this.vignetteOffsetY = vTop;
      this.vignette.style.transform = `translate3d(${left}px, ${vTop}px, 0)`;
    }
    const dpr = this.dpr;
    this._fxCtx.setTransform(dpr, 0, 0, dpr, -left * dpr, -top * dpr);
    return { left, top, right: left + this.fxW, bottom: top + this.fxH };
  }

  private render() {
    const time = this.lastTime / 1000;
    const ctx = this._fxCtx;
    const view = this.positionFx();

    if (this.particles.length === 0 && this.flames.length === 0) {
      // Nothing to draw: clear once after the last active frame, then leave the
      // canvas (and the compositor) completely alone while idle.
      if (this.fxPainted) {
        ctx.clearRect(view.left, view.top, this.fxW, this.fxH);
        this.fxPainted = false;
      }
      return;
    }
    ctx.clearRect(view.left, view.top, this.fxW, this.fxH);
    this.fxPainted = true;

    // One classification pass. Particles live in document space and the page
    // can be far taller than the screen, so anything outside the fx band is
    // dropped here instead of being submitted and clipped by the canvas.
    const wet = this.bucketWet;
    const puff = this.bucketPuff;
    const bit = this.bucketBit;
    const hot = this.bucketHot;
    wet.length = puff.length = bit.length = hot.length = 0;
    for (const p of this.particles) {
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
          bit.push(p);
          break;
        case "ember":
        case "spark":
        case "flash":
        case "ring":
        case "streak":
        case "jet":
        case "sparkle":
          hot.push(p);
          break;
      }
    }

    // Wet marks + splashes under everything else. Wet patches are a soft sheen
    // rather than a filled ellipse — a hard-edged blob reads as a grey stain on
    // a dark page, where a feathered one reads as a surface that is damp.
    const sprite = sprites();
    for (const p of wet) {
      if (p.kind !== "wet") continue;
      const t = p.life / p.maxLife;
      blitRect(ctx, sprite.mist, p.x, p.y, p.size * 1.5, p.size * 0.95, 0.16 * (1 - t));
    }
    ctx.globalAlpha = 1;
    for (const p of wet) {
      if (p.kind === "wet") continue;
      const t = p.life / p.maxLife;
      if (p.kind === "stream") {
        // The unbroken column of water leaving the nozzle, before it fans out
        // into droplets. Drawn opaque, not additively — water occludes.
        blitStreak(ctx, sprite.streakWater, p.x, p.y, p.angle ?? 0, p.len ?? 40, p.size, 0.85 * (1 - t * 0.6));
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
      ctx.ellipse(p.x, p.y, p.size * 0.7, p.size * 1.3, Math.atan2(p.vy, p.vx) + Math.PI / 2, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Smoke, steam and dust (normal blending, soft grey/white).
    for (const p of puff) {
      const t = p.life / p.maxLife;
      if (p.kind === "dust") {
        blit(ctx, sprite.dust, p.x, p.y, p.size * (1 + t * 2.6), 0.3 * (1 - t) * Math.min(1, t * 8));
        continue;
      }
      if (p.kind === "steam") {
        blit(ctx, sprite.steam, p.x, p.y, p.size * (1 + t * 2.2), 0.32 * (1 - t) * Math.min(1, t * 6));
        continue;
      }
      // Smoke: born lit by the fire it came off, cooling to grey as it climbs,
      // and swaying so a column rolls rather than sliding straight up.
      const sway = Math.sin(time * 1.6 + (p.phase ?? 0)) * p.size * 0.5 * t;
      const fade = (1 - t) * Math.min(1, t * 5);
      if (t < 0.35) blit(ctx, sprite.smokeWarm, p.x + sway, p.y, p.size * (1 + t * 2.4), 0.34 * fade * (1 - t / 0.35));
      blit(ctx, sprite.smoke, p.x + sway, p.y, p.size * (1 + t * 2.6), 0.3 * fade);
    }
    ctx.globalAlpha = 1;

    // Solid bits: debris, casings, sawdust, paint drips, and flying page shards.
    for (const p of bit) {
      const t = p.life / p.maxLife;
      if (p.kind === "paint") {
        // The wet head of a drip; the run it leaves behind is stamped on death.
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = p.color ?? "#e63946";
        ctx.beginPath();
        ctx.ellipse(p.x, p.y - (p.len ?? 0) * 0.5, p.size * 0.5, p.size * 0.5 + (p.len ?? 0) * 0.5, 0, 0, TAU);
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

    // Additive pass: flames, embers, sparks, muzzle flashes.
    ctx.globalCompositeOperation = "lighter";
    for (const f of this.flames) {
      if (f.y < view.top - 300 || f.y > view.bottom + 300) continue;
      if (f.x < view.left - 300 || f.x > view.right + 300) continue;
      this.renderFlame(ctx, f, time);
    }
    for (const p of hot) {
      const t = p.life / p.maxLife;
      switch (p.kind) {
        case "ember":
          blit(ctx, t < 0.5 ? sprite.emberHot : sprite.emberCool, p.x, p.y, p.size * (1 - t * 0.5) * 1.6, 1 - t);
          break;
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
          blit(ctx, sprite.shockRing, p.x, p.y, p.size * (0.35 + t * 1.9), (1 - t) * (1 - t) * 0.85);
          break;
        case "streak":
          blitStreak(ctx, sprite.streakHot, p.x, p.y, p.angle ?? 0, p.len ?? 40, p.size, (1 - t) * 0.9);
          break;
        case "jet": {
          // Flamethrower fuel: white-hot at the nozzle, swelling and cooling as
          // it flies. The size ramp is what turns a line of dots into a cone.
          const r = p.size * (0.5 + t * 2.6);
          blit(ctx, t < 0.3 ? sprite.flameCore : sprite.flameHigh, p.x, p.y, r, (1 - t) * 0.62);
          blit(ctx, sprite.flameLow, p.x, p.y, r * 1.35, (1 - t) * 0.34);
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
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
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
  private renderFlame(ctx: CanvasRenderingContext2D, f: Flame, time: number) {
    const flicker = 0.85 + 0.15 * Math.sin(time * 13 + f.seed) + 0.08 * Math.sin(time * 29 + f.seed * 2);
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
    // top, rising well clear of the hole so the fire licks upward.
    const layers = 7;
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

  private updateShake(dt: number) {
    const settled =
      this.shakeAmount <= 0.2 &&
      Math.abs(this.kickX) < 0.15 &&
      Math.abs(this.kickY) < 0.15 &&
      Math.abs(this.shakeRoll) < 0.00012;
    if (!settled) {
      const s = this.shakeAmount;
      const tx = (Math.random() - 0.5) * s + this.kickX;
      const ty = (Math.random() - 0.5) * s + this.kickY;
      const roll = this.shakeRoll + (Math.random() - 0.5) * s * 0.00022;
      // Pivot around the middle of what the user is looking at. The container
      // spans the whole document, so the default 50%/50% origin would swing the
      // top of a long page by tens of pixels for a fraction of a degree.
      this.container.style.transformOrigin = `50% ${this.scrollY + this.viewportH * 0.5}px`;
      this.container.style.transform = `translate(${tx}px, ${ty}px) rotate(${roll}rad)`;
      const decay = Math.exp(-dt * 14);
      this.shakeAmount *= decay;
      this.kickX *= decay;
      this.kickY *= decay;
      // The roll unwinds more slowly than the rattle, so a big hit leaves the
      // page visibly tilting back rather than snapping straight.
      this.shakeRoll *= Math.exp(-dt * 8);
    } else if (this.container.style.transform) {
      this.container.style.transform = "";
      this.shakeAmount = 0;
      this.kickX = this.kickY = this.shakeRoll = 0;
    }
  }

  /**
   * Deepen the vignette as damage piles up. Only ever a CSS opacity change, and
   * only when it would actually be visible — the transition smooths the steps.
   */
  private updateVignette() {
    const target = Math.min(0.85, this.destruction);
    if (Math.abs(target - this.vignetteShown) < 0.02) return;
    this.vignetteShown = target;
    this.vignette.style.opacity = target.toFixed(3);
  }

  private updateLoops() {
    const heat = Math.min(1, this.flames.reduce((sum, f) => sum + f.intensity, 0) / 4);
    this.sound.loop("fire", heat * 0.5);
  }
}
