/**
 * Minimal WebGL2 helpers shared by the content surface renderer.
 *
 * Deliberately tiny: one full-screen quad, one vertex shader, programs whose
 * uniform locations are discovered by introspection rather than listed by hand.
 * `postfx.ts` predates this and stays on WebGL1 with its own helpers — it draws
 * a transient effects layer where a lost context costs nothing, whereas the
 * content surface holds the page itself and needs the tighter WebGL2 feature
 * set (integer texture sizing, `texSubImage2D` from a canvas at an offset).
 */

import type { PerfCounterName, PerfCounterSink } from "./performance";

/**
 * Full-screen triangle strip in clip space. `vUv` is flipped on Y at sample
 * time rather than here, because every source we bind (2D canvases) has its
 * origin at the top-left while GL texture space starts at the bottom.
 */
export const QUAD_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export interface GLProgram {
  program: WebGLProgram;
  /** Every active uniform, keyed by the name the shader declares. */
  uniforms: Record<string, WebGLUniformLocation>;
}

/**
 * Compile, link and introspect a fragment shader against `QUAD_VERT`.
 *
 * Returns null rather than throwing: every caller has a non-GL fallback, and a
 * driver that refuses to compile should degrade the toy, not break the page.
 */
export function createProgram(gl: WebGL2RenderingContext, frag: string): GLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, QUAD_VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // Shaders are reference-counted by the program; drop our handles either way.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[RageLayer] shader link failed:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  const uniforms: Record<string, WebGLUniformLocation> = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const location = gl.getUniformLocation(program, info.name);
    if (location) uniforms[info.name] = location;
  }
  return { program, uniforms };
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  console.warn("[RageLayer] shader compile failed:", gl.getShaderInfoLog(shader));
  gl.deleteShader(shader);
  return null;
}

/** The one vertex buffer everything draws with. Bind once, draw forever. */
export function createQuad(gl: WebGL2RenderingContext): WebGLBuffer {
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  return quad;
}

/**
 * A sampling texture with the settings every source here wants: bilinear, and
 * clamped so a refracted sample that walks off the page repeats the edge pixel
 * instead of wrapping around to the far side of the document.
 */
export function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Largest square texture this context will accept, for the fallback check. */
export function maxTextureSize(gl: WebGL2RenderingContext): number {
  return gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
}

// ── Canvas→texture upload cost ──────────────────────────────────────────────

/**
 * Per-upload cost above which the per-frame canvas→GL pipelines lose more in
 * transfer than they gain in shading, and the engine should present its plain
 * 2D canvases instead. Chromium uploads canvas sources GPU-to-GPU (~0.01ms);
 * Gecko and WebKit currently pay a fixed multi-millisecond toll *per call*,
 * regardless of how small the rectangle is — and a frame can need eight or
 * more of them, so even 1ms per call would not fit the budget.
 */
export const SLOW_UPLOAD_THRESHOLD_MS = 1.0;

const UPLOAD_PROBE_SIZE = 256;
const UPLOAD_PROBE_ITERATIONS = 3;

let uploadCostMs: number | null = null;

/** The probed per-upload cost, for telemetry. Null until any context probed. */
export function measuredUploadCostMs(): number | null {
  return uploadCostMs;
}

/** Test hook: forget the cached probe result. */
export function resetUploadCostCache() {
  uploadCostMs = null;
}

/**
 * Measure what one `texSubImage2D` from a 2D canvas costs on this browser.
 *
 * The result is a property of the browser, not the context, so it is probed
 * once per page and cached — the surface renderer and the post-FX stage both
 * consult it, whichever initialises first pays. Runs a handful of small
 * uploads with a `finish()` fence; on the engines where uploads are slow the
 * cost is synchronous CPU conversion, so wall clock around the calls captures
 * it even at 1ms timer resolution. Anything that throws (test stubs, lost
 * contexts) reports fast: the caller keeps today's behaviour and real
 * browsers do not throw here.
 */
export function canvasUploadCostMs(gl: WebGLRenderingContext | WebGL2RenderingContext): number {
  if (uploadCostMs !== null) return uploadCostMs;
  try {
    const source = document.createElement("canvas");
    source.width = UPLOAD_PROBE_SIZE;
    source.height = UPLOAD_PROBE_SIZE;
    const ctx = source.getContext("2d");
    if (!ctx) return (uploadCostMs = 0);
    ctx.fillRect(0, 0, UPLOAD_PROBE_SIZE, UPLOAD_PROBE_SIZE);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      UPLOAD_PROBE_SIZE,
      UPLOAD_PROBE_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    // Warm-up upload so one-time path setup is not billed to the measurement.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.finish();
    const start = performance.now();
    for (let i = 0; i < UPLOAD_PROBE_ITERATIONS; i++) {
      // Touch the source so a browser cannot serve a cached snapshot.
      ctx.fillRect(i, 0, 1, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
    gl.finish();
    uploadCostMs = (performance.now() - start) / UPLOAD_PROBE_ITERATIONS;
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.deleteTexture(tex);
  } catch {
    uploadCostMs = 0;
  }
  return uploadCostMs;
}

// ── GPU pass timing ─────────────────────────────────────────────────────────

/** The constants both disjoint timer-query extensions share. */
interface DisjointTimerExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** WebGL1 `EXT_disjoint_timer_query`: query objects live on the extension. */
interface DisjointTimerExt1 extends DisjointTimerExt {
  readonly QUERY_RESULT_EXT: number;
  readonly QUERY_RESULT_AVAILABLE_EXT: number;
  createQueryEXT(): WebGLQuery | null;
  deleteQueryEXT(query: WebGLQuery): void;
  beginQueryEXT(target: number, query: WebGLQuery): void;
  endQueryEXT(target: number): void;
  getQueryObjectEXT(query: WebGLQuery, pname: number): number | boolean;
}

/** In-flight query cap. When results lag this far behind, frames go untimed. */
const MAX_PENDING_QUERIES = 4;

/**
 * Asynchronous GPU timing for one render pass, built on
 * `EXT_disjoint_timer_query_webgl2` (WebGL2) or `EXT_disjoint_timer_query`
 * (WebGL1) where the driver offers one.
 *
 * Wrap a pass in `begin()`/`end()`, then `poll(sink, name)` on later frames to
 * report whichever results have landed — results are never waited for, so this
 * can never stall the pipeline. Query objects come from a small fixed pool and
 * are reused, keeping the per-frame path allocation-free. Everything degrades
 * to a no-op: a missing context, a missing extension, or a query call that
 * throws just leaves `available` false. Follows this file's no-throw contract.
 */
export class GpuTimer {
  /** True while the context exposes a usable timer-query extension. */
  available = false;
  private gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  private gl2: WebGL2RenderingContext | null = null;
  private ext: DisjointTimerExt | null = null;
  private ext1: DisjointTimerExt1 | null = null;
  /** Fixed pool used as a ring: `head` is the oldest in-flight query. */
  private readonly queries: (WebGLQuery | null)[] = new Array(MAX_PENDING_QUERIES).fill(null);
  private head = 0;
  private pending = 0;
  private active = false;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext | null) {
    if (!gl) return;
    try {
      const gl2 =
        typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext
          ? gl
          : null;
      if (gl2) {
        this.ext = gl2.getExtension("EXT_disjoint_timer_query_webgl2") as DisjointTimerExt | null;
      } else {
        this.ext1 = gl.getExtension("EXT_disjoint_timer_query") as DisjointTimerExt1 | null;
        this.ext = this.ext1;
      }
      if (!this.ext) return;
      this.gl = gl;
      this.gl2 = gl2;
      this.available = true;
    } catch {
      this.available = false;
    }
  }

  /** Start timing this frame's pass. Skipped while the query pool is full. */
  begin() {
    if (!this.available || this.active || this.pending >= MAX_PENDING_QUERIES) return;
    try {
      const slot = (this.head + this.pending) % MAX_PENDING_QUERIES;
      const query = (this.queries[slot] ??= this.gl2
        ? this.gl2.createQuery()
        : this.ext1!.createQueryEXT());
      if (!query) return;
      if (this.gl2) this.gl2.beginQuery(this.ext!.TIME_ELAPSED_EXT, query);
      else this.ext1!.beginQueryEXT(this.ext!.TIME_ELAPSED_EXT, query);
      this.active = true;
    } catch {
      this.available = false;
    }
  }

  /** Close the pass opened by `begin()`. Safe to call unconditionally. */
  end() {
    if (!this.active) return;
    this.active = false;
    try {
      if (this.gl2) this.gl2.endQuery(this.ext!.TIME_ELAPSED_EXT);
      else this.ext1!.endQueryEXT(this.ext!.TIME_ELAPSED_EXT);
      this.pending++;
    } catch {
      this.available = false;
    }
  }

  /**
   * Report every resolved query to `sink` as `name` milliseconds, one call per
   * result, oldest first. Also records that a working timer exists, so the
   * monitor can distinguish "no GPU work ran" from "no extension".
   */
  poll(sink: PerfCounterSink | null, name: PerfCounterName) {
    if (!this.available || !sink) return;
    sink.count("gpuTimerAvailable", 0);
    if (this.pending === 0) return;
    try {
      const gl = this.gl!;
      // A disjoint event (GPU clock discontinuity) invalidates every pending
      // result; drop them rather than report garbage.
      if (gl.getParameter(this.ext!.GPU_DISJOINT_EXT) === true) {
        this.head = (this.head + this.pending) % MAX_PENDING_QUERIES;
        this.pending = 0;
        return;
      }
      while (this.pending > 0) {
        const query = this.queries[this.head]!;
        const ready = this.gl2
          ? (this.gl2.getQueryParameter(query, this.gl2.QUERY_RESULT_AVAILABLE) as boolean)
          : (this.ext1!.getQueryObjectEXT(query, this.ext1!.QUERY_RESULT_AVAILABLE_EXT) as boolean);
        if (!ready) break;
        const nanoseconds = this.gl2
          ? (this.gl2.getQueryParameter(query, this.gl2.QUERY_RESULT) as number)
          : (this.ext1!.getQueryObjectEXT(query, this.ext1!.QUERY_RESULT_EXT) as number);
        sink.count(name, nanoseconds / 1e6);
        this.head = (this.head + 1) % MAX_PENDING_QUERIES;
        this.pending--;
      }
    } catch {
      this.available = false;
    }
  }

  dispose() {
    try {
      for (let i = 0; i < this.queries.length; i++) {
        const query = this.queries[i];
        if (!query) continue;
        if (this.gl2) this.gl2.deleteQuery(query);
        else this.ext1?.deleteQueryEXT(query);
        this.queries[i] = null;
      }
    } catch {
      // The context may already be lost; there is nothing left to release.
    }
    this.available = false;
    this.pending = 0;
    this.head = 0;
    this.active = false;
    this.gl = null;
    this.gl2 = null;
    this.ext = null;
    this.ext1 = null;
  }
}
