/**
 * CaptureController — turning the real page into something destructible, and
 * keeping it that way.
 *
 * The whole trick of this package lives here. The live DOM is rasterized into a
 * canvas, the real DOM is hidden (`visibility`, so layout and scrolling
 * survive), and the copy becomes the page — after which destruction removes
 * actual content pixels rather than drawing over them.
 *
 * There are two ways to take that raster, and this owns the choice between
 * them and the fallback between them:
 *
 * - **snapshot** — html-to-image's foreignObject technique. Works everywhere;
 *   the page is frozen at activation.
 * - **live** — Chrome's experimental `drawElementImage`. The page stays live
 *   underneath and is re-captured roughly once a second, wounds preserved.
 *   Failures here always fall back to snapshot rather than breaking the toy.
 *
 * It also owns everything that has to happen *before* the real DOM disappears:
 * harvesting the page's furniture for the demolition tool and mapping where
 * the text is for the surface shader. After `enterContentMode` there is
 * nothing left to measure.
 */

import { MAX_CAPTURE_HEIGHT, measureCapture, pickPixelRatio, resolvePageBackdrop } from "./capture";
import { ContentLayer } from "./content";
import { harvestElements, type PageElement } from "./elements";
import { LiveContentSource, supportsLiveCapture } from "./live";
import type { Overlay } from "./overlay";
import { DEFAULT_SURFACE_PARAMS, type SurfaceParams } from "./surface";
import { buildTextMask } from "./textmask";
import type { CaptureMode, CaptureStatus, EngineErrorScope } from "./types";

export interface CaptureSettings {
  root: HTMLElement;
  mode: CaptureMode;
  liveRefreshMs: number;
  /**
   * Record page furniture so demolition can knock real elements loose. Pointless
   * without the physics world to hand the pieces to, so both have to be on.
   */
  harvestElements: boolean;
  physics: boolean;
  /** Map the page's text lines so the shader keeps glyphs crisp along tears. */
  textMask: boolean;
  filter: (node: Node) => boolean;
  /** `false` mounts the raw 2D canvas; an object overrides the shader defaults. */
  surface: Partial<SurfaceParams> | false | undefined;
}

/** What the pipeline needs from the engine around it. */
export interface CaptureHost {
  readonly overlay: Overlay;
  /** Document size, already capped to what a canvas can hold. */
  docSize(): { width: number; height: number };
  /** The document rows a live refresh should cover — what the user can see. */
  refreshBand(): { y0: number; y1: number };
  /** Page furniture measured while the real layout still exists. */
  onElements(elements: PageElement[]): void;
  onStatusChange(): void;
  onError(scope: EngineErrorScope, message: string, cause?: unknown): void;
  /**
   * A fresh capture succeeded. Its geometry may differ from the last one, so
   * old pixel checkpoints describe a page that no longer exists.
   */
  onCaptureLanded(): void;
  /** A capture attempt finished, successfully or not. */
  onCaptureSettled(durationMs: number): void;
}

export class CaptureController {
  /** Non-null once a capture has been attempted; `ready` once one succeeded. */
  private layer: ContentLayer | null = null;
  /** Non-null only while live mode is actually in use. */
  private liveSource: LiveContentSource | null = null;
  /** Shader settings for the destructible surface, applied on every capture. */
  private readonly surfaceParams: SurfaceParams;
  /** False when the host asked for `surface: false` — mount the 2D canvas raw. */
  private readonly shading: boolean;
  private root: HTMLElement | null;
  private previousRootVisibility: string | null = null;
  private capturing = false;
  private refreshing = false;
  private refreshTimer = 0;
  /** Extra delay before the next live refresh after a failure; 0 when healthy. */
  private backoffMs = 0;
  private status: CaptureStatus = "idle";
  private unavailable: boolean;
  private disposed = false;

  constructor(
    private readonly host: CaptureHost,
    private readonly settings: CaptureSettings,
  ) {
    this.root = settings.root;
    this.shading = settings.surface !== false;
    // Applied before the first capture, so the very first frame is shaded the
    // way the host asked rather than snapping to it a frame later.
    this.surfaceParams = settings.surface
      ? { ...DEFAULT_SURFACE_PARAMS, ...settings.surface }
      : { ...DEFAULT_SURFACE_PARAMS };
    // Asked for live on a browser without the flag: record it up front so the
    // toolbar can say *why* it is in snapshot mode.
    this.unavailable = settings.mode === "live" && !supportsLiveCapture();
  }

  /** What the pipeline is doing. Changes reach the host as a status event. */
  get captureStatus(): CaptureStatus {
    return this.status;
  }

  /** Live mode was requested but the experimental API isn't available. */
  get liveUnavailable(): boolean {
    return this.unavailable;
  }

  /** The destructible page, or null until a capture has succeeded. */
  get content(): ContentLayer | null {
    return this.layer?.ready ? this.layer : null;
  }

  /** The root being captured. Null after disposal. */
  get contentRoot(): HTMLElement | null {
    return this.root;
  }

  /**
   * Install a ready-made layer, bypassing rasterization: mounts its canvas in
   * the right place in the stack and switches the destroyer onto it. For hosts
   * that pre-render their own page raster, and for tests that need a
   * destructible surface without driving the whole pipeline.
   */
  install(layer: ContentLayer | null) {
    this.layer = layer;
    if (!layer) return;
    const overlay = this.host.overlay;
    overlay.container.insertBefore(layer.canvas, overlay.damageCanvas);
  }

  /** Rasterize the page and switch the destroyer onto the copy. */
  async capture() {
    if (this.capturing || this.disposed || !this.root) return;
    const startedAt = performance.now();
    this.capturing = true;
    this.setStatus("capturing");
    try {
      const layer = (this.layer ??= new ContentLayer());
      // Set before the capture: `adopt` is what brings the renderer up, so this
      // has to be known by then rather than applied to it afterwards.
      layer.shadingEnabled = this.shading;
      // Match the overlay's own geometry so the destructible surface, the void
      // and the fx canvas share one coordinate space.
      const doc = this.host.docSize();
      const geometry = measureCapture(this.root, doc.width, doc.height, MAX_CAPTURE_HEIGHT);
      const backdrop = resolvePageBackdrop(this.root);
      this.harvest();

      const live = await this.rasterize(layer, geometry, backdrop);
      if (this.disposed) return;

      // The renderer is (re-)created by `adopt`, so its settings are re-applied
      // here rather than once at construction.
      layer.surfaceParams = { ...this.surfaceParams };
      this.applyTextMask(layer, geometry);

      // Content canvas sits between the void backdrop and the damage canvas.
      const overlay = this.host.overlay;
      overlay.container.insertBefore(layer.canvas, overlay.damageCanvas);
      this.enterContentMode();
      this.host.onCaptureLanded();
      this.setStatus(live ? "live" : "snapshot");
      if (live) this.scheduleRefresh();
    } catch (err) {
      // Capture can fail (e.g. CORS-tainted resources). Fall back to
      // overlay-only damage rather than breaking the toy.
      this.host.onError("capture", "page capture failed, using overlay mode", err);
      this.layer?.dispose();
      this.layer = null;
      this.setStatus("idle");
    } finally {
      this.capturing = false;
      this.host.onCaptureSettled(performance.now() - startedAt);
    }
  }

  /**
   * Live mode: re-capture the page now, keeping every wound. No-op in snapshot
   * mode, or while a capture/refresh is already in flight.
   */
  async refresh() {
    const layer = this.layer;
    if (!this.liveSource || !layer?.ready || !layer.live) return;
    if (this.refreshing || this.capturing || this.disposed || !this.root) return;
    // A hidden tab still runs timers but its rAF is throttled to a crawl, and
    // the capture awaits two frames. Skip rather than pile up.
    if (document.hidden) return;
    this.refreshing = true;
    try {
      const doc = this.host.docSize();
      const geometry = measureCapture(this.root, doc.width, doc.height, MAX_CAPTURE_HEIGHT);
      // A reflow invalidates the whole capture; the resize handler owns that.
      if (geometry.width !== layer.width || geometry.height !== layer.height) return;

      // Fast path: the mirror is already mounted and its animations run in step
      // with the page's, so a refresh is one draw call rather than a clone of
      // the whole DOM. Falls through to the full capture when the browser has
      // no paint events, or when the paint record went stale.
      const raster =
        this.liveSource.repaint() ??
        (await this.liveSource.capture(this.root, geometry.width, geometry.height, layer.dpr, {
          source: geometry.source,
          rootSize: geometry.rootSize,
          backdrop: resolvePageBackdrop(this.root),
          filter: this.settings.filter,
        }));
      if (this.disposed) return;
      // Refresh only what the user can see plus a screen either side — the page
      // below the fold keeps last refresh's (still pristine) pixels.
      layer.refreshBase(raster, this.host.refreshBand());
      // The refresh runs off a timer, not the frame loop — which parks itself
      // whenever nothing is animating. Presenting here pushes the recomposed
      // band through the surface renderer even on an idle page; otherwise the
      // new pixels sit in the texture source until the next tool use.
      layer.present();
      this.backoffMs = 0;
    } catch (err) {
      // A failed refresh just means the base is a little stale — the existing
      // pixels and all the destruction are still on screen. Back off (doubling
      // up to a minute) and keep retrying rather than giving up forever; a
      // success resets the backoff. The configured interval is never mutated.
      this.backoffMs = Math.min(
        60_000,
        Math.max(this.settings.liveRefreshMs * 4, this.backoffMs * 2),
      );
      this.host.onError("live-refresh", "live refresh failed, keeping last capture", err);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Put the real DOM's visibility back. Called on disposal, and on `pagehide`
   * so a bfcache-restored document never comes back blank.
   */
  exitContentMode() {
    if (this.root && this.previousRootVisibility !== null) {
      this.root.style.visibility = this.previousRootVisibility;
      this.previousRootVisibility = null;
    }
    this.host.overlay.showVoid(false);
  }

  /**
   * A reflow changed the document's size, which invalidates the whole raster.
   * Tear the current capture down and take a fresh one.
   */
  recaptureAfterReflow() {
    if (this.disposed || !this.layer) return;
    const next = this.host.docSize();
    if (this.layer.width === next.width && this.layer.height === next.height) return;
    clearTimeout(this.refreshTimer);
    this.exitContentMode();
    this.layer.ready = false;
    void this.capture();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = 0;
    this.exitContentMode();
    this.layer?.dispose();
    this.layer = null;
    this.liveSource?.dispose();
    this.liveSource = null;
    this.setStatus("idle");
    this.root = null;
    this.previousRootVisibility = null;
  }

  /**
   * Take the raster, preferring live and falling back to snapshot. Returns
   * whether the live path won.
   */
  private async rasterize(
    layer: ContentLayer,
    geometry: ReturnType<typeof measureCapture>,
    backdrop: ReturnType<typeof resolvePageBackdrop>,
  ): Promise<boolean> {
    if (this.settings.mode !== "snapshot" && supportsLiveCapture()) {
      try {
        await this.captureLive(layer, geometry, backdrop);
        return true;
      } catch (err) {
        // "live" was best-effort or explicit; either way a working toy beats a
        // broken one, so drop to the snapshot path.
        if (this.settings.mode === "live") {
          this.unavailable = true;
          this.host.onError("live-capture", "live capture failed, falling back to snapshot", err);
        }
      }
    }
    if (this.disposed) return false;

    layer.live = false;
    await layer.capture(this.root!, geometry.width, geometry.height, this.settings.filter, {
      source: geometry.source,
      rootSize: geometry.rootSize,
      backdrop,
    });
    if (!this.disposed) {
      this.liveSource?.dispose();
      this.liveSource = null;
    }
    return false;
  }

  /** First live capture: raster the page through `drawElementImage`. */
  private async captureLive(
    layer: ContentLayer,
    geometry: ReturnType<typeof measureCapture>,
    backdrop: ReturnType<typeof resolvePageBackdrop>,
  ) {
    const source = (this.liveSource ??= new LiveContentSource());
    layer.dpr = pickPixelRatio(geometry.width, geometry.height);
    const raster = await source.capture(this.root!, geometry.width, geometry.height, layer.dpr, {
      source: geometry.source,
      rootSize: geometry.rootSize,
      backdrop,
      filter: this.settings.filter,
    });
    if (this.disposed) throw new Error("disposed");
    // Set before adopt: `adopt` resets the wound buffers, and `live` decides
    // whether damage is recorded into them at all.
    layer.live = true;
    layer.adopt(raster, geometry.width, geometry.height);
  }

  /**
   * Map the page's furniture while the real layout still exists — after
   * `enterContentMode` there is nothing left to measure.
   */
  private harvest() {
    if (!this.settings.harvestElements || !this.settings.physics || !this.root) return;
    try {
      this.host.onElements(harvestElements(this.root, this.settings.filter));
    } catch (err) {
      // A hostile layout shouldn't cost the user the whole toy.
      this.host.onError("element-harvest", "element harvest failed, demolition disabled", err);
      this.host.onElements([]);
    }
  }

  /**
   * Map where the page has type on it, so the shader can keep glyphs crisp
   * where a tear runs through them. Measures live line boxes, so it has to run
   * before the real DOM is hidden.
   */
  private applyTextMask(layer: ContentLayer, geometry: ReturnType<typeof measureCapture>) {
    if (!this.settings.textMask || !layer.shaded || !this.root) return;
    try {
      layer.setTextMask(
        buildTextMask(this.root, geometry.width, geometry.height, this.settings.filter),
      );
    } catch (err) {
      // Purely an enhancement; a page that resists measurement still works.
      this.host.onError("text-mask", "text mask failed, shading uniformly", err);
    }
  }

  /** Hide the real DOM but keep its layout (scrollbars, page height). */
  private enterContentMode() {
    if (!this.root || !this.layer?.ready) return;
    if (this.previousRootVisibility === null) {
      this.previousRootVisibility = this.root.style.visibility;
    }
    // Our own container un-hides itself — visibility, unlike display, can be
    // re-enabled on descendants.
    this.root.style.visibility = "hidden";
    this.host.overlay.container.style.visibility = "visible";
    this.host.overlay.showVoid(true);
  }

  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (this.settings.liveRefreshMs <= 0 || this.disposed) return;
    this.refreshTimer = window.setTimeout(
      () => {
        void this.refresh().then(() => this.scheduleRefresh());
      },
      Math.max(this.settings.liveRefreshMs, this.backoffMs),
    );
  }

  private setStatus(status: CaptureStatus) {
    if (this.status === status) return;
    this.status = status;
    this.host.onStatusChange();
  }
}
