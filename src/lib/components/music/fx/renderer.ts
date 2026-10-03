import type { Box } from './canvas';
import { flashAt, ROWS, type Score } from './score';
import { ATLAS_COLUMNS, channels, FRAGMENT, glyphSlot, SCORE_WIDTH, vertexShader, type Effect } from './shader';

const FONT_SIZE = 13;
const CELL_HEIGHT = 18;
/** Printable ASCII, the start of every atlas. */
const ASCII = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index));

export type Frame = {
  effect: Effect;
  score: Score | null;
  /** Seconds into the song. */
  position: number;
  /** The player's box, in CSS pixels. */
  box: Box;
  /** The effect's lines of text. */
  texts: string[];
};

type Program = { program: WebGLProgram; uniforms: Map<string, WebGLUniformLocation | null> };
/** A program still compiling, and its shaders. */
type Compiling = { program: WebGLProgram; shaders: WebGLShader[] };
/**
 * What the renderer has on the GPU: the glyph atlas and the score, as textures; and, where the
 * browser has it, the extension that compiles programs in the background.
 */
type Gpu = {
  atlasTexture: WebGLTexture;
  scoreTexture: WebGLTexture;
  parallel: KHR_parallel_shader_compile | null;
};

/**
 * Draws the FX page's effects on the GPU. The window is a grid of character cells, each drawn as
 * one point: the effect's shader works out what it shows (see `shader.ts`), and the fragment
 * shader copies its glyph out of an atlas of every character, drawn once in white.
 *
 * The browser can take the GPU away (phones do when the page is in the background, and drivers
 * when they reset). Everything on it is lost then, so when it comes back it is all set up again.
 */
export class FxRenderer {
  private readonly atlas = document.createElement('canvas');
  /** The glyphs' font, and a cell's width for it in CSS pixels. */
  private readonly font = `600 ${FONT_SIZE}px ${getComputedStyle(document.body).fontFamily}`;
  private readonly cellWidth: number;
  private gpu: Gpu;
  /** Each effect's program: compiled, still compiling, or null if it does not compile. */
  private readonly programs = new Map<string, Program | Compiling | null>();
  /** The effects to compile ahead of time, again if the GPU is taken away. */
  private prepared: readonly Effect[] = [];
  private atlasKey = '';
  private extra: string[] = [];
  private text = new Int32Array(256);
  private lines = new Int32Array(8);
  private score: Score | null = null;
  private drawn = '';

  /** The GPU taken away: the browser is told it is wanted back. */
  private readonly lost = (event: Event) => event.preventDefault();
  /** The GPU back, with nothing on it: all set up again, and the next frame drawn in full. */
  private readonly restored = () => {
    this.programs.clear();
    this.atlasKey = '';
    this.score = null;
    this.drawn = '';
    this.gpu = this.setUp();
    this.prepare(this.prepared);
  };

  /** A renderer for `canvas`, or null if the browser has no WebGL2. */
  static create(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, premultipliedAlpha: true });
    return gl && new FxRenderer(canvas, gl);
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
  ) {
    const context = this.atlas.getContext('2d')!;
    context.font = this.font;
    this.cellWidth = Math.ceil(context.measureText('M').width) + 1;
    this.gpu = this.setUp();
    canvas.addEventListener('webglcontextlost', this.lost);
    canvas.addEventListener('webglcontextrestored', this.restored);
  }

  /** Sets the GPU up for drawing, with empty textures. */
  private setUp(): Gpu {
    const { gl } = this;
    gl.bindVertexArray(gl.createVertexArray());
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return {
      atlasTexture: this.texture(),
      scoreTexture: this.texture(),
      parallel: gl.getExtension('KHR_parallel_shader_compile'),
    };
  }

  /**
   * Starts compiling the effects' programs in the background, where the browser can, so the page
   * does not stall as each is first shown: until the browser has one cached, it can take a second
   * or more. Elsewhere each is compiled as it is first shown.
   */
  prepare(effects: readonly Effect[]) {
    this.prepared = effects;
    if (this.gpu.parallel) for (const effect of effects) this.compile(effect);
  }

  /** Draws a frame, unless it would look just like the last one (as it does while paused). */
  draw({ effect, score, position, box, texts }: Frame) {
    const { gl, canvas } = this;
    if (gl.isContextLost()) return;
    const ratio = canvas.width / innerWidth;
    const cell = [Math.round(this.cellWidth * ratio), Math.round(CELL_HEIGHT * ratio)];
    const grid = [Math.ceil(canvas.width / cell[0]), Math.ceil(canvas.height / cell[1])];
    const key = [
      position,
      effect.id,
      canvas.width,
      canvas.height,
      box.left,
      box.top,
      box.right,
      box.bottom,
      ...texts,
    ].join('\n');
    if (key === this.drawn && score === this.score) return;
    this.drawn = key;
    this.useText(texts, cell, ratio);
    this.useScore(score);

    gl.viewport(0, 0, canvas.width, canvas.height);
    // The background flashes as a peak comes in, under the glyphs.
    const flash = score ? flashAt(score, position) : 0;
    const [red, green, blue] = channels(effect.flash);
    gl.clearColor(red * flash, green * flash, blue * flash, flash);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const program = score && this.program(effect);
    // Still compiling: this frame is drawn again until it is ready.
    if (program === undefined) this.drawn = '';
    if (!score || !program) return;

    gl.useProgram(program.program);
    const uniform = (name: string) => {
      if (!program.uniforms.has(name)) program.uniforms.set(name, gl.getUniformLocation(program.program, name));
      return program.uniforms.get(name)!;
    };
    gl.uniform1f(uniform('u_time'), position);
    gl.uniform1i(uniform('u_score'), 0);
    gl.uniform1i(uniform('u_atlas'), 1);
    gl.uniform1i(uniform('u_steps'), score.steps);
    gl.uniform2f(uniform('u_view'), canvas.width / ratio, canvas.height / ratio);
    gl.uniform2f(uniform('u_cell'), cell[0] / ratio, cell[1] / ratio);
    gl.uniform4f(uniform('u_player'), box.left, box.top, box.right, box.bottom);
    gl.uniform2i(uniform('u_grid'), grid[0], grid[1]);
    gl.uniform4iv(uniform('u_text'), this.text);
    gl.uniform2iv(uniform('u_texts'), this.lines);
    gl.uniform2f(uniform('u_pixels'), canvas.width, canvas.height);
    gl.uniform2f(uniform('u_cellPixels'), cell[0], cell[1]);
    gl.drawArrays(gl.POINTS, 0, grid[0] * grid[1]);
  }

  destroy() {
    this.canvas.removeEventListener('webglcontextlost', this.lost);
    this.canvas.removeEventListener('webglcontextrestored', this.restored);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private texture() {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /** Writes the effect's text into its uniforms, and draws the atlas again if it needs more glyphs or the cells changed size. */
  private useText(texts: string[], cell: number[], ratio: number) {
    const lines = texts.slice(0, 4).map((text) => [...text].slice(0, 64));
    const extra = [...new Set(lines.flat().filter((char) => glyphSlot(char) === 0 && char !== ' '))].sort();
    const key = `${cell} ${extra.join('')}`;
    if (key !== this.atlasKey) {
      this.atlasKey = key;
      this.extra = extra;
      this.drawAtlas(cell, ratio);
    }
    this.text.fill(0);
    this.lines.fill(0);
    let at = 0;
    lines.forEach((line, index) => {
      this.lines.set([at, line.length], index * 2);
      for (const char of line) this.text[at++] = glyphSlot(char, this.extra);
    });
  }

  private drawAtlas([width, height]: number[], ratio: number) {
    const { gl, atlas } = this;
    const glyphs = [...ASCII, ...this.extra];
    atlas.width = ATLAS_COLUMNS * width;
    atlas.height = Math.ceil(glyphs.length / ATLAS_COLUMNS) * height;
    const context = atlas.getContext('2d')!;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.font = this.font;
    context.textBaseline = 'middle';
    context.fillStyle = '#fff';
    glyphs.forEach((glyph, slot) => {
      const [x, y] = [(slot % ATLAS_COLUMNS) * width, Math.floor(slot / ATLAS_COLUMNS) * height];
      context.fillText(glyph, x / ratio, (y + height / 2) / ratio, width / ratio);
    });
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gpu.atlasTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  }

  private useScore(score: Score | null) {
    if (score === this.score) return;
    this.score = score;
    if (!score) return;
    const { gl } = this;
    const texels = score.steps * ROWS;
    const rows = Math.floor(texels / SCORE_WIDTH);
    const rest = texels - rows * SCORE_WIDTH;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gpu.scoreTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, SCORE_WIDTH, rows + (rest ? 1 : 0), 0, gl.RGBA, gl.FLOAT, null);
    // Straight from the score, without a copy (a mix hours long is tens of megabytes): its whole
    // rows, then what is left in a last, shorter one.
    if (rows) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SCORE_WIDTH, rows, gl.RGBA, gl.FLOAT, score.table, 0);
    if (rest)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, rows, rest, 1, gl.RGBA, gl.FLOAT, score.table, rows * SCORE_WIDTH * 4);
  }

  /** Starts compiling the effect's program, unless it has been already. */
  private compile(effect: Effect) {
    if (this.programs.has(effect.id)) return;
    const { gl } = this;
    const program = gl.createProgram();
    const shaders = (
      [
        [gl.VERTEX_SHADER, vertexShader(effect)],
        [gl.FRAGMENT_SHADER, FRAGMENT],
      ] as const
    ).map(([type, source]) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      return shader;
    });
    // Nothing asks how it went until it is done, which would wait for it.
    gl.linkProgram(program);
    this.programs.set(effect.id, { program, shaders });
  }

  /** The effect's program: undefined while it is still compiling, and null if it does not compile. */
  private program(effect: Effect) {
    this.compile(effect);
    const entry = this.programs.get(effect.id)!;
    if (!entry || 'uniforms' in entry) return entry;
    const { gl } = this;
    const { parallel } = this.gpu;
    if (parallel && !gl.getProgramParameter(entry.program, parallel.COMPLETION_STATUS_KHR)) return undefined;
    const linked = gl.getProgramParameter(entry.program, gl.LINK_STATUS);
    if (!linked) {
      for (const shader of entry.shaders)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          console.error(`The ${effect.id} effect's shader:`, gl.getShaderInfoLog(shader));
      console.error(`The ${effect.id} effect's program:`, gl.getProgramInfoLog(entry.program));
    }
    for (const shader of entry.shaders) gl.deleteShader(shader);
    const compiled = linked ? { program: entry.program, uniforms: new Map() } : null;
    this.programs.set(effect.id, compiled);
    return compiled;
  }
}
