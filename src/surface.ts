/**
 * SurfaceRenderer — the destructible page, presented through a fragment shader.
 *
 * This is the architecture canvasui.dev uses for every one of its components,
 * pointed at destruction instead of decoration: the 2D canvas stops being the
 * thing on screen and becomes a *source texture*, and a WebGL canvas takes its
 * place in the DOM. Tools keep drawing Path2D geometry into the 2D surface
 * exactly as before — `destination-out` for removal, `source-atop` for char —
 * and the shader is what turns that flat alpha cutout into something that looks
 * like torn material.
 *
 * The wound field is not a separate buffer. The surface's own **alpha channel**
 * already is one: 1 where the page survives, 0 where a tool took it away. Its
 * gradient across a tear gives a surface normal for free, which drives all
 * three of the things a flat cutout is missing:
 *
 * - **Refraction.** Pixels near a tear sample the page slightly off-centre,
 *   along the gradient, so the lip of a hole bends what is behind it the way a
 *   curled edge does.
 * - **Dispersion.** That offset is scaled per channel, fringing the lip.
 * - **Relief.** The same normal is lit, so one side of every tear catches the
 *   light and the other falls into shadow — the single cue that reads as
 *   "thickness" rather than "someone deleted some pixels".
 *
 * Two properties are load-bearing and easy to lose:
 *
 * 1. **An undamaged page must be bit-identical to the raster.** Every effect
 *    above scales with the alpha gradient, which is zero across intact page, and
 *    the quad samples at exact texel centres, so `LINEAR` returns exact texels.
 *    Capture fidelity work is not undone by presenting through GL.
 * 2. **The silhouette must stay exact.** Output alpha is the *unrefracted*
 *    sample, so a refracted colour never leaks opaque pixels into a hole.
 *
 * Cost is bounded by dirty rectangles on both sides: `texSubImage2D` uploads
 * only the region a tool touched (via WebGL2's `UNPACK_SKIP_*` sub-rect
 * addressing), and `gl.scissor` restricts the raster to the same region, with
 * `preserveDrawingBuffer` holding everything else. Without that, a page-sized
 * canvas would re-upload and re-shade ~14M pixels on every frame fire is
 * spreading.
 *
 * If anything here is unavailable the renderer reports `available === false`
 * and `ContentLayer` presents the 2D canvas directly, which is what it did
 * before this file existed.
 */

import { createProgram, createQuad, createTexture, maxTextureSize, type GLProgram } from "./gl";

const FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uContent;
uniform sampler2D uText;
uniform vec2 uTexel;
uniform float uEdge;
uniform float uRefract;
uniform float uDispersion;
uniform float uRelief;
uniform float uRim;
uniform float uCharEdge;
uniform float uHasText;
/** Singularity: centre x/y in device px, event-horizon radius, strength 0..1. */
uniform vec4 uWarp;
/** Slab thickness in device px. 0 disables the cut-side rendering. */
uniform float uDepth;
uniform float uTime;

/** Up and to the left, matching the char sprites' baked-in highlight. */
const vec3 LIGHT = vec3(-0.4558, 0.6076, 0.6511);

float alphaAt (vec2 uv) {
  return texture(uContent, uv).a;
}

float hash (vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main () {
  // The source is a 2D canvas: its origin is top-left, GL's is bottom-left.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);

  // ── Gravitational lensing ─────────────────────────────────────────────────
  // Thin-lens approximation of a point mass: a pixel at apparent radius wr
  // shows light from true radius sqrt(wr² − k·rs²). Far from the hole that
  // decays as 1/wr — the physically correct falloff — and near the horizon it
  // dives to zero, so the page visibly stretches and pours inward. A
  // frame-dragging swirl (strongest at the horizon, gone by ~4rs) twists the
  // infall, and a photon ring brightens the last stable orbit.
  float horizon = 0.0;
  float photonRing = 0.0;
  if (uWarp.w > 0.001) {
    vec2 texPx = uv / uTexel;
    vec2 wd = texPx - uWarp.xy;
    float wr = max(length(wd), 1e-3);
    float rs = max(uWarp.z, 2.0);
    float sr = sqrt(max(wr * wr - rs * rs * (3.5 * uWarp.w), 0.0));
    // The time term winds the infall tighter the longer the hole is held —
    // frame dragging accumulating — capped so it never aliases into noise.
    float swirl = uWarp.w * (2.4 + min(uTime, 8.0) * 0.55)
      * exp(-max(wr - rs, 0.0) / (rs * 1.6));
    float cs = cos(swirl);
    float sn = sin(swirl);
    vec2 dir = mat2(cs, -sn, sn, cs) * (wd / wr);
    uv = clamp((uWarp.xy + dir * sr) * uTexel, vec2(0.0), vec2(1.0));
    horizon = (1.0 - smoothstep(rs * 0.85, rs * 1.05, wr)) * uWarp.w;
    photonRing = exp(-abs(wr - rs * 1.45) / (rs * 0.22)) * uWarp.w;
  }

  float a = alphaAt(uv);

  vec2 step = uTexel * max(uEdge, 0.5);
  float aLeft  = alphaAt(uv - vec2(step.x, 0.0));
  float aRight = alphaAt(uv + vec2(step.x, 0.0));
  float aAbove = alphaAt(uv - vec2(0.0, step.y));
  float aBelow = alphaAt(uv + vec2(0.0, step.y));

  // Screen-space gradient (+y is up), pointing from removed page toward intact
  // page. Zero everywhere the page is whole, which is what makes an undamaged
  // capture pass through untouched.
  vec2 grad = vec2(aRight - aLeft, aAbove - aBelow) * 0.5;
  float edge = clamp(length(grad) * 2.0, 0.0, 1.0);

  // Text keeps its refraction damped so glyphs near a tear read as cut rather
  // than smeared. The lighting below is left alone — that is the cue that says
  // the cut has an edge at all.
  float text = uHasText > 0.5 ? texture(uText, uv).r : 0.0;
  float crisp = 1.0 - 0.75 * text;

  // Back into texture space, where +y runs down.
  vec2 gradTex = vec2(grad.x, -grad.y);
  vec2 offset = gradTex * uRefract * crisp * step;
  float spread = uDispersion * crisp;

  vec3 col = vec3(
    texture(uContent, uv + offset * (1.0 + spread)).r,
    texture(uContent, uv + offset).g,
    texture(uContent, uv + offset * (1.0 - spread)).b
  );

  // Light the tear. Subtracting LIGHT.z means a flat normal produces exactly no
  // change, so this cannot tint the intact page.
  vec3 normal = normalize(vec3(-grad * uRelief * 14.0, 1.0));
  float diffuse = clamp(dot(normal, LIGHT), 0.0, 1.0);
  col *= clamp(1.0 + (diffuse - LIGHT.z) * uRim, 0.3, 1.9);

  // Torn fibre shadow, hugging the surviving side of the cut.
  col *= 1.0 - uCharEdge * edge * a;

  // ── Slab depth ────────────────────────────────────────────────────────────
  // The page is a board, not a sheet: inside a hole, just below the top edge,
  // the viewer sees the *cut side* of the material. March upward from each
  // transparent pixel; if intact page sits within uDepth device px above, this
  // pixel is side wall — plywood tone, horizontal grain, darker with depth.
  if (uDepth > 0.5 && a < 0.5) {
    float depth = 0.0;
    for (int t = 1; t <= 16; t++) {
      if (float(t) > uDepth) break;
      if (alphaAt(uv - vec2(0.0, uTexel.y * float(t))) > 0.5) {
        depth = float(t);
        break;
      }
    }
    if (depth > 0.5) {
      vec2 px = uv / uTexel;
      // Grain: long horizontal streaks (coarse hash per row band) over a fine
      // per-pixel flicker, both static so the wood doesn't shimmer.
      float streak = 0.84 + 0.16 * hash(vec2(floor(px.y - depth), floor(px.x * 0.011)));
      float fleck = 0.94 + 0.06 * hash(px);
      float shade = 1.0 - depth / (uDepth + 2.0);
      col = vec3(0.50, 0.36, 0.22) * streak * fleck * (0.40 + 0.60 * shade);
      a = 0.94;
    }
  }

  // ── Singularity compositing ───────────────────────────────────────────────
  // Photon ring first (lensed light piling up at the last orbit), then the
  // event horizon paints over everything — including the ring's inner half.
  col += vec3(1.0, 0.72, 0.42) * photonRing * 0.85;
  col = mix(col, vec3(0.0), horizon);
  a = mix(a, 1.0, horizon);

  outColor = vec4(col, a);
}`;

export interface SurfaceParams {
  /** Gradient sample radius in device px. Wider reads as thicker material. */
  edge: number;
  /** How far the lip of a tear bends the page behind it. */
  refraction: number;
  /** Per-channel scaling of that bend, 0 for colour-true. */
  dispersion: number;
  /** How steeply the tear's normal tips away from the page plane. */
  relief: number;
  /** Strength of the lighting on that normal. */
  rim: number;
  /** Darkening of the surviving side of a cut. */
  charEdge: number;
  /**
   * Material thickness in CSS px. Inside every hole, the cut side of the slab
   * is rendered just below the top edge — the page reads as a wooden board
   * rather than paper. 0 restores the flat look.
   */
  depth: number;
}

/**
 * How long a region drawn *outside* any reported dirty rect can stay invisible.
 *
 * Incremental uploads are only as correct as the bounds their callers report,
 * and a mark that lands outside every reported rect would otherwise never reach
 * the screen at all — it would sit in the source canvas, unshown, until
 * something else happened to dirty the same pixels. That failure mode is
 * indistinguishable from "the tool is broken", so damage also schedules a whole-
 * surface reconcile at this interval: the fast path stays fast, and the worst a
 * mis-reported bound can cost is a few frames of latency instead of the mark.
 */
const RECONCILE_MS = 900;

export const DEFAULT_SURFACE_PARAMS: SurfaceParams = {
  edge: 2.5,
  refraction: 2.2,
  dispersion: 0.35,
  relief: 0.55,
  rim: 0.9,
  charEdge: 0.35,
  depth: 6,
};

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export class SurfaceRenderer {
  readonly canvas: HTMLCanvasElement;
  /** False when WebGL2 is missing, refuses, or the page is too big to texture. */
  available = false;
  /** Set false to skip shaded presentation entirely (`surface: false`). */
  enabled = true;
  params: SurfaceParams = { ...DEFAULT_SURFACE_PARAMS };

  private gl: WebGL2RenderingContext | null = null;
  private program: GLProgram | null = null;
  private quad: WebGLBuffer | null = null;
  private contentTex: WebGLTexture | null = null;
  private textTex: WebGLTexture | null = null;
  private hasText = false;
  private width = 0;
  private height = 0;
  /** Device pixels per CSS px in the source canvas, for CSS-px params. */
  pixelScale = 1;
  /** Pending upload/redraw region in device px, or null when nothing changed. */
  private dirty: Rect | null = null;
  /** `performance.now()` of the last whole-surface upload. */
  private lastFull = 0;
  /** Damage has been marked since then, so a reconcile is still owed. */
  private owesFull = false;
  /** Active singularity warp, in device px, or null. */
  private warp: { x: number; y: number; r: number; strength: number } | null = null;
  /** Where the warp painted last frame — must be redrawn once after it moves or ends. */
  private prevWarpRect: Rect | null = null;
  /** `performance.now()` when the current warp activated, for the swirl wind-up. */
  private warpStart = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
    } satisfies Partial<CSSStyleDeclaration>);
  }

  /**
   * Bring up the context for a page of `width`×`height` *device* px. Safe to
   * call again on re-capture; the textures are re-allocated to the new size.
   */
  init(width: number, height: number): boolean {
    this.available = false;
    if (!this.enabled) return false;
    const gl =
      this.gl ??
      (this.canvas.getContext("webgl2", {
        alpha: true,
        depth: false,
        stencil: false,
        antialias: false,
        // The 2D surface holds straight (un-premultiplied) alpha and the shader
        // emits the same, so the compositor must be told not to assume
        // premultiplied — otherwise every soft edge gets a dark halo.
        premultipliedAlpha: false,
        // Rendering is scissored to dirty rectangles, so everything outside the
        // damaged region has to survive from the previous frame.
        preserveDrawingBuffer: true,
      }) as WebGL2RenderingContext | null);
    if (!gl || gl.isContextLost()) return false;
    this.gl = gl;

    const limit = maxTextureSize(gl);
    if (width > limit || height > limit || width < 1 || height < 1) return false;

    if (!this.program) {
      this.program = createProgram(gl, FRAG);
      if (!this.program) return false;
      this.quad = createQuad(gl);
      this.contentTex = createTexture(gl);
      this.textTex = createTexture(gl);
    }

    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;

    // Storage only — the first `render` fills it from the surface canvas.
    gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    this.available = true;
    this.warp = null;
    this.prevWarpRect = null;
    this.markAllDirty();
    return true;
  }

  /** Set the CSS size of the presented canvas (document px). */
  setDisplaySize(width: number, height: number) {
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  /** Install the text mask built at capture time. Null clears it. */
  setTextMask(mask: HTMLCanvasElement | null) {
    const gl = this.gl;
    if (!gl || !this.textTex) return;
    this.hasText = Boolean(mask);
    if (!mask) return;
    gl.bindTexture(gl.TEXTURE_2D, this.textTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
    this.markAllDirty();
  }

  /**
   * Note that a region of the surface changed, in device px. Callers pass the
   * geometry they drew; the padding for the shader's own sampling reach is
   * added here so no caller has to know the effect's radius.
   */
  markDirty(x0: number, y0: number, x1: number, y1: number) {
    if (!this.available) return;
    // The shader reads `uEdge` texels out and refracts by up to `uRefract`
    // more, and the slab side extends `depth` px below a wound's top edge — so
    // a wound perturbs pixels beyond its own bounds.
    const { edge, refraction, depth } = this.params;
    const pad = Math.ceil(edge * (2 + Math.abs(refraction)) + depth * this.pixelScale + 2);
    const nx0 = Math.max(0, Math.floor(x0) - pad);
    const ny0 = Math.max(0, Math.floor(y0) - pad);
    const nx1 = Math.min(this.width, Math.ceil(x1) + pad);
    const ny1 = Math.min(this.height, Math.ceil(y1) + pad);
    if (nx1 <= nx0 || ny1 <= ny0) return;
    this.owesFull = true;
    const d = this.dirty;
    if (!d) {
      this.dirty = { x0: nx0, y0: ny0, x1: nx1, y1: ny1 };
      return;
    }
    // One union rather than a list: destruction clusters around the cursor, so
    // the union stays tight, and a single scissored pass beats N state changes.
    d.x0 = Math.min(d.x0, nx0);
    d.y0 = Math.min(d.y0, ny0);
    d.x1 = Math.max(d.x1, nx1);
    d.y1 = Math.max(d.y1, ny1);
  }

  markAllDirty() {
    if (!this.available) return;
    this.dirty = { x0: 0, y0: 0, x1: this.width, y1: this.height };
  }

  /**
   * Drive the gravitational-lensing warp, in device px. Call every frame while
   * a singularity is active and once with null when it ends — the renderer
   * repaints the region it warped so the page straightens back out.
   *
   * The warp is pure shading: no texture upload happens for it, only a
   * re-render of the influenced rectangle, so driving it per-frame is cheap.
   */
  setWarp(x: number, y: number, r: number, strength: number): void;
  setWarp(clear: null): void;
  setWarp(x: number | null, y = 0, r = 0, strength = 0) {
    if (x === null) {
      this.warp = null;
      return;
    }
    if (!this.warp) this.warpStart = performance.now();
    this.warp = { x, y, r, strength };
  }

  /** The rectangle the current warp visually influences, in device px. */
  private warpRect(): Rect | null {
    const w = this.warp;
    if (!w) return null;
    // Deflection is ~1/r; by 10 horizon radii the shift is sub-pixel.
    const reach = Math.min(Math.max(w.r * 10, 160), 2400);
    return {
      x0: Math.max(0, Math.floor(w.x - reach)),
      y0: Math.max(0, Math.floor(w.y - reach)),
      x1: Math.min(this.width, Math.ceil(w.x + reach)),
      y1: Math.min(this.height, Math.ceil(w.y + reach)),
    };
  }

  get needsRender(): boolean {
    if (!this.available) return false;
    // A reconcile is owed and due: widen to the whole surface so anything a
    // caller under-reported gets picked up. Cheap in practice — it only fires
    // while damage is actually happening, and at most every RECONCILE_MS.
    if (this.owesFull && performance.now() - this.lastFull >= RECONCILE_MS) this.markAllDirty();
    return this.dirty !== null || this.warp !== null || this.prevWarpRect !== null;
  }

  /**
   * Upload whatever changed in `source` and re-shade it. No-op when nothing is
   * dirty, which is the common case on a frame where only particles moved.
   */
  render(source: HTMLCanvasElement) {
    const gl = this.gl;
    const program = this.program;
    if (!gl || !program || !this.available) return;
    if (gl.isContextLost()) {
      this.available = false;
      return;
    }

    // Upload and re-render are separate concerns: damage needs both, the warp
    // needs only a re-render (the texture under it is unchanged). The drawn
    // region is the union of everything that changed on screen — including
    // wherever the warp painted last frame, which must be drawn once more
    // after it moves or ends so the page straightens back out.
    const upload = this.dirty;
    this.dirty = null;
    const warpNow = this.warpRect();
    const region = unionRect(unionRect(upload, warpNow), this.prevWarpRect);
    this.prevWarpRect = warpNow;
    if (!region) return;

    if (upload) {
      const w = upload.x1 - upload.x0;
      const h = upload.y1 - upload.y0;
      gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
      if (w === this.width && h === this.height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        this.lastFull = performance.now();
        this.owesFull = false;
      } else {
        // WebGL2 sub-rect addressing of a canvas source: without these the
        // whole page-sized canvas would be re-read for a hammer-sized wound.
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, source.width);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, upload.x0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, upload.y0);
        gl.texSubImage2D(
          gl.TEXTURE_2D,
          0,
          upload.x0,
          upload.y0,
          w,
          h,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          source,
        );
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      }
    }

    gl.useProgram(program.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const u = program.uniforms;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.contentTex);
    if (u.uContent) gl.uniform1i(u.uContent, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textTex);
    if (u.uText) gl.uniform1i(u.uText, 1);
    if (u.uTexel) gl.uniform2f(u.uTexel, 1 / this.width, 1 / this.height);
    if (u.uHasText) gl.uniform1f(u.uHasText, this.hasText ? 1 : 0);
    const p = this.params;
    if (u.uEdge) gl.uniform1f(u.uEdge, p.edge);
    if (u.uRefract) gl.uniform1f(u.uRefract, p.refraction);
    if (u.uDispersion) gl.uniform1f(u.uDispersion, p.dispersion);
    if (u.uRelief) gl.uniform1f(u.uRelief, p.relief);
    if (u.uRim) gl.uniform1f(u.uRim, p.rim);
    if (u.uCharEdge) gl.uniform1f(u.uCharEdge, p.charEdge);
    if (u.uDepth) gl.uniform1f(u.uDepth, Math.min(16, p.depth * this.pixelScale));
    const warp = this.warp;
    if (u.uWarp) {
      if (warp) gl.uniform4f(u.uWarp, warp.x, warp.y, warp.r, warp.strength);
      else gl.uniform4f(u.uWarp, 0, 0, 0, 0);
    }
    if (u.uTime) {
      gl.uniform1f(u.uTime, warp ? (performance.now() - this.warpStart) / 1000 : 0);
    }

    gl.viewport(0, 0, this.width, this.height);
    // GL's y axis runs up from the bottom of the drawing buffer; the region
    // was measured against a top-left origin.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(region.x0, this.height - region.y1, region.x1 - region.x0, region.y1 - region.y0);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.SCISSOR_TEST);
  }

  dispose() {
    const gl = this.gl;
    this.available = false;
    this.dirty = null;
    this.warp = null;
    this.prevWarpRect = null;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program.program);
      if (this.quad) gl.deleteBuffer(this.quad);
      if (this.contentTex) gl.deleteTexture(this.contentTex);
      if (this.textTex) gl.deleteTexture(this.textTex);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.program = null;
    this.quad = null;
    this.contentTex = null;
    this.textTex = null;
    this.gl = null;
    this.width = 0;
    this.height = 0;
    this.hasText = false;
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.remove();
  }
}
