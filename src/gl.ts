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
