/**
 * WebGL post-processing for the effects layer.
 *
 * The 2D fx canvas can draw a convincing flame, but it cannot make one *glow* —
 * light bleeding past its own silhouette, air shimmering above it, the page
 * behind it fringing red where the heat bends the light. Those are all
 * neighbourhood operations, and canvas 2D has no way to express them at frame
 * rate.
 *
 * So the fx canvas is demoted to an offscreen source texture and this class
 * owns the canvas that is actually in the DOM. Every frame:
 *
 * 1. **Bright pass** — everything above a luminance threshold, into a
 *    quarter-resolution buffer (bloom is a blur; blurring at full res is four
 *    times the bandwidth for a result nobody can distinguish).
 * 2. **Separable blur** — two 9-tap passes, horizontal then vertical,
 *    ping-ponging between two buffers.
 * 3. **Composite** — the fx layer sampled through a heat-haze UV offset and a
 *    radial chromatic split, plus the bloom added on top.
 *
 * The heat field is a tiny 2D canvas the engine stamps flame blobs into; using
 * a texture rather than a uniform array means the shimmer costs the same
 * whether one flame is burning or forty.
 *
 * Everything degrades safely: if the context is missing or a program fails to
 * link, `available` stays false and the engine puts the plain 2D fx canvas back
 * in the DOM. Nothing else in the engine knows the difference.
 */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** Bright pass. Multiplying by alpha keeps transparent pixels from blooming. */
const FRAG_BRIGHT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform float uThreshold;
void main() {
  vec4 c = texture2D(uSrc, vUv);
  vec3 rgb = c.rgb * c.a;
  float luma = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float w = max(0.0, luma - uThreshold) / max(0.0001, 1.0 - uThreshold);
  gl_FragColor = vec4(rgb * w, 1.0);
}`;

/** Separable Gaussian. uDir is a single-texel step along one axis. */
const FRAG_BLUR = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;
void main() {
  vec3 sum = texture2D(uSrc, vUv).rgb * 0.2270270270;
  sum += texture2D(uSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture2D(uSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  sum += texture2D(uSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  sum += texture2D(uSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

/**
 * Composite.
 *
 * The heat field drives two things at once: a wobble in the sample position
 * (rising air) and the strength of the chromatic split (hot air disperses).
 * Two sine frequencies at different rates keep the shimmer from reading as a
 * single sloshing wave.
 */
const FRAG_COMPOSITE = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uFx;
uniform sampler2D uBloom;
uniform sampler2D uHeat;
uniform float uTime;
uniform float uBloom0;
uniform float uHeat0;
uniform float uAberration;

void main() {
  float heat = texture2D(uHeat, vUv).r;
  float wobble = sin(vUv.y * 90.0 - uTime * 6.0) * 0.55 + sin(vUv.x * 61.0 + uTime * 4.1) * 0.45;
  vec2 offset = vec2(wobble, sin(vUv.y * 40.0 - uTime * 9.0)) * heat * uHeat0;

  vec2 uv = vUv + offset;
  // Radial split, strongest at the edges and wherever the air is hottest.
  vec2 fromCentre = uv - 0.5;
  float split = (uAberration + heat * 0.004) * (0.35 + dot(fromCentre, fromCentre));
  vec4 cr = texture2D(uFx, uv + fromCentre * split);
  vec4 cg = texture2D(uFx, uv);
  vec4 cb = texture2D(uFx, uv - fromCentre * split);

  vec3 rgb = vec3(cr.r, cg.g, cb.b);
  float a = max(cg.a, max(cr.a, cb.a));
  vec3 bloom = texture2D(uBloom, vUv).rgb * uBloom0;

  // Bloom is emissive: it has to raise alpha too, or the glow is invisible
  // everywhere the effects layer is transparent — which is exactly where a
  // halo lives.
  rgb = rgb * a + bloom;
  float outA = clamp(a + dot(bloom, vec3(0.4)), 0.0, 1.0);
  gl_FragColor = vec4(outA > 0.001 ? rgb / outA : rgb, outA);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[desktop-destroyer] shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function link(gl: WebGLRenderingContext, fragSrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "aPos");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[desktop-destroyer] program link failed:", gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

interface PostFXUniforms {
  brightSource: WebGLUniformLocation | null;
  brightThreshold: WebGLUniformLocation | null;
  blurSource: WebGLUniformLocation | null;
  blurDirection: WebGLUniformLocation | null;
  compositeFx: WebGLUniformLocation | null;
  compositeBloom: WebGLUniformLocation | null;
  compositeHeat: WebGLUniformLocation | null;
  compositeTime: WebGLUniformLocation | null;
  compositeBloomStrength: WebGLUniformLocation | null;
  compositeHeatStrength: WebGLUniformLocation | null;
  compositeAberration: WebGLUniformLocation | null;
}

export interface PostFXParams {
  /** Bloom intensity, 0 disables the blur passes entirely. */
  bloom: number;
  /** Heat-haze displacement, in UV units at full heat. */
  heat: number;
  /** Chromatic split, in UV units. Scales with how wrecked the page is. */
  aberration: number;
  /** Seconds, for the shimmer animation. */
  time: number;
}

/** How much smaller the bloom buffers are than the screen. */
const BLOOM_SCALE = 4;

export class PostFX {
  readonly canvas: HTMLCanvasElement;
  /** False if WebGL is unavailable — the engine then uses the 2D canvas. */
  available = false;

  private gl: WebGLRenderingContext | null = null;
  private quad: WebGLBuffer | null = null;
  private progBright: WebGLProgram | null = null;
  private progBlur: WebGLProgram | null = null;
  private progComposite: WebGLProgram | null = null;
  private fxTex: WebGLTexture | null = null;
  private heatTex: WebGLTexture | null = null;
  private ping: Target | null = null;
  private pong: Target | null = null;
  private uniforms: PostFXUniforms | null = null;
  private w = 0;
  private h = 0;
  private heatW = 0;
  private heatH = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    Object.assign(this.canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      transformOrigin: "0 0",
      willChange: "transform",
    } satisfies Partial<CSSStyleDeclaration>);

    const gl = this.canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // Nothing is read back, and the effects layer is redrawn every frame.
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    }) as WebGLRenderingContext | null;
    if (!gl) return;

    this.progBright = link(gl, FRAG_BRIGHT);
    this.progBlur = link(gl, FRAG_BLUR);
    this.progComposite = link(gl, FRAG_COMPOSITE);
    if (!this.progBright || !this.progBlur || !this.progComposite) return;
    this.uniforms = {
      brightSource: gl.getUniformLocation(this.progBright, "uSrc"),
      brightThreshold: gl.getUniformLocation(this.progBright, "uThreshold"),
      blurSource: gl.getUniformLocation(this.progBlur, "uSrc"),
      blurDirection: gl.getUniformLocation(this.progBlur, "uDir"),
      compositeFx: gl.getUniformLocation(this.progComposite, "uFx"),
      compositeBloom: gl.getUniformLocation(this.progComposite, "uBloom"),
      compositeHeat: gl.getUniformLocation(this.progComposite, "uHeat"),
      compositeTime: gl.getUniformLocation(this.progComposite, "uTime"),
      compositeBloomStrength: gl.getUniformLocation(this.progComposite, "uBloom0"),
      compositeHeatStrength: gl.getUniformLocation(this.progComposite, "uHeat0"),
      compositeAberration: gl.getUniformLocation(this.progComposite, "uAberration"),
    };

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    // One oversized triangle covering the viewport: fewer vertices than a quad
    // and no diagonal seam in the interpolated UVs.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.fxTex = this.makeTexture(gl);
    this.heatTex = this.makeTexture(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    // The fx and heat sources are 2D canvases: their first row is the *top* of
    // the layer, while GL's first texel row is the bottom. Without this every
    // upload lands vertically mirrored, and the composite samples it that way.
    //
    // It hid for a long time because the fx layer used to be nothing but
    // flames, smoke and sparks — soft, roughly symmetric blobs that look much
    // the same either way up. Rigid-body debris is the first thing on this
    // layer with a legible orientation, and it made the flip obvious: chunks
    // carrying page text rendered upside down, at a mirrored height, appearing
    // to fall upwards.
    //
    // Flipping at upload (rather than in the shader) keeps every downstream
    // stage in one orientation: the bright pass and both blur passes read from
    // FBOs that GL itself rendered, so they are already bottom-up, and the
    // composite then needs no special case for which of its inputs came from a
    // canvas and which from a render target.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    this.gl = gl;
    this.available = true;
  }

  private makeTexture(gl: WebGLRenderingContext): WebGLTexture | null {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private makeTarget(gl: WebGLRenderingContext, w: number, h: number): Target | null {
    const tex = this.makeTexture(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return ok ? { fbo, tex, w, h } : null;
  }

  /** Match the backing store to the fx canvas. CSS size is the caller's job. */
  resize(pixelWidth: number, pixelHeight: number, cssWidth: number, cssHeight: number) {
    const gl = this.gl;
    if (!gl || (pixelWidth === this.w && pixelHeight === this.h)) {
      this.canvas.style.width = `${cssWidth}px`;
      this.canvas.style.height = `${cssHeight}px`;
      return;
    }
    this.w = pixelWidth;
    this.h = pixelHeight;
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    // Allocate source storage once per resize. `texImage2D(canvas)` redefines
    // the texture and may allocate backing memory every frame; subsequent
    // frames only replace the pixels with `texSubImage2D`.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fxTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      pixelWidth,
      pixelHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    for (const t of [this.ping, this.pong]) {
      if (!t) continue;
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    const bw = Math.max(1, Math.floor(pixelWidth / BLOOM_SCALE));
    const bh = Math.max(1, Math.floor(pixelHeight / BLOOM_SCALE));
    this.ping = this.makeTarget(gl, bw, bh);
    this.pong = this.makeTarget(gl, bw, bh);
    if (!this.ping || !this.pong) this.available = false;
  }

  private draw(target: Target | null) {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * Run the chain. `fx` is the offscreen 2D effects canvas, `heat` the low-res
   * heat field. Both are uploaded fresh — they change every frame by design.
   */
  render(fx: HTMLCanvasElement, heat: HTMLCanvasElement, params: PostFXParams) {
    const gl = this.gl;
    const uniforms = this.uniforms;
    if (!gl || !uniforms || !this.available || !this.ping || !this.pong) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fxTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, fx);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.heatTex);
    if (heat.width !== this.heatW || heat.height !== this.heatH) {
      this.heatW = heat.width;
      this.heatH = heat.height;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        this.heatW,
        this.heatH,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, heat);

    const bloomOn = params.bloom > 0.01;
    if (bloomOn) {
      gl.useProgram(this.progBright);
      gl.uniform1i(uniforms.brightSource, 0);
      gl.uniform1f(uniforms.brightThreshold, 0.34);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fxTex);
      this.draw(this.ping);

      gl.useProgram(this.progBlur);
      gl.uniform1i(uniforms.blurSource, 0);
      // Horizontal, then vertical: a separable Gaussian is 2×5 taps instead of
      // the 25 a 2D kernel of the same radius would need.
      gl.bindTexture(gl.TEXTURE_2D, this.ping.tex);
      gl.uniform2f(uniforms.blurDirection, 1 / this.ping.w, 0);
      this.draw(this.pong);
      gl.bindTexture(gl.TEXTURE_2D, this.pong.tex);
      gl.uniform2f(uniforms.blurDirection, 0, 1 / this.ping.h);
      this.draw(this.ping);
    }

    const prog = this.progComposite!;
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fxTex);
    gl.uniform1i(uniforms.compositeFx, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomOn ? this.ping.tex : this.pong.tex);
    gl.uniform1i(uniforms.compositeBloom, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.heatTex);
    gl.uniform1i(uniforms.compositeHeat, 2);
    gl.uniform1f(uniforms.compositeTime, params.time);
    gl.uniform1f(uniforms.compositeBloomStrength, bloomOn ? params.bloom : 0);
    gl.uniform1f(uniforms.compositeHeatStrength, params.heat);
    gl.uniform1f(uniforms.compositeAberration, params.aberration);
    gl.activeTexture(gl.TEXTURE0);
    this.draw(null);
  }

  /** Blank the output without running the chain (nothing to show this frame). */
  clear() {
    const gl = this.gl;
    if (!gl) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose() {
    const gl = this.gl;
    if (gl) {
      for (const t of [this.ping, this.pong]) {
        if (!t) continue;
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.tex);
      }
      gl.deleteTexture(this.fxTex);
      gl.deleteTexture(this.heatTex);
      gl.deleteBuffer(this.quad);
      for (const p of [this.progBright, this.progBlur, this.progComposite]) {
        if (p) gl.deleteProgram(p);
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.gl = null;
    this.uniforms = null;
    this.available = false;
    this.w = 0;
    this.h = 0;
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.canvas.remove();
  }
}
