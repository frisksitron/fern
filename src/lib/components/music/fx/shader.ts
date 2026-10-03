import { TRACK_MAP_STEP } from '$lib/shared/contracts/track-map';
import { ROWS } from './score';

/**
 * What the effects are written in. The window is a grid of characters, and an effect is a GLSL
 * function the GPU runs for every cell of it on every frame:
 *
 *     Cell draw(vec2 p, ivec2 at)
 *
 * given the middle of the cell `p` (CSS pixels from the top left of the window) and its column
 * and row `at`, returning the character it shows, in what colour, and how strongly (`put` layers
 * one over another). It has nothing to go on but the playback position `u_time`, the song's score
 * (`musicAt` any moment, and the `latest` kick, snare, hi-hat, or peak by then), the player's box,
 * and the playing song's text, so the picture follows the seek bar 1-to-1. Anything random is
 * hashed from the cell or the event (`random`), so it comes out the same every time.
 *
 * Effects cannot move things from frame to frame, so movement is worked out backwards from where a
 * cell is: something travelling out from the player at 500 px/s shows, 250 px out, what happened
 * half a second ago; `drifter` and `burst` find the particle a cell has, if any.
 */

export type Song = { title: string; artist: string; album: string };

/** One of the FX page's effects: how it looks, and the shader that draws it. */
export type Effect = {
  id: string;
  name: string;
  /** The page's colour behind it; `dark` when light text reads better over it. */
  background: string;
  dark?: boolean;
  /** The colour the background flashes as a peak comes in. */
  flash: string;
  /** Up to four lines of text (64 characters each) the shader can write, from the playing song. */
  texts?: (song: Song) => string[];
  /** GLSL defining `Cell draw(vec2 p, ivec2 at)`, and whatever it needs. */
  shader: string;
};

/** Texels across the score's texture (every WebGL2 device takes 2048). */
export const SCORE_WIDTH = 2048;
/** Glyphs across the glyph atlas. */
export const ATLAS_COLUMNS = 16;

/** A character's place in the glyph atlas: printable ASCII first, then `extra` characters. */
export function glyphSlot(char: string, extra: readonly string[] = []) {
  const code = char.charCodeAt(0);
  if (char.length === 1 && code >= 32 && code < 127) return code - 32;
  const index = extra.indexOf(char);
  return index < 0 ? 0 : 95 + index;
}

/** A colour such as `#8fa7c9` as red, green, and blue from 0 to 1. */
export function channels(hex: string) {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
}

/** A colour such as `#8fa7c9` as a GLSL `vec3`. */
export function rgb(hex: string) {
  return `vec3(${channels(hex)
    .map((channel) => channel.toFixed(3))
    .join(', ')})`;
}

/** The glyphs shaders use by name. */
const GLYPHS = {
  SPACE: ' ',
  DOT: '.',
  COLON: ':',
  DASH: '-',
  EQUALS: '=',
  PLUS: '+',
  STAR: '*',
  HASH: '#',
  PERCENT: '%',
  ATSIGN: '@',
  BAR: '|',
  SLASH: '/',
  BACKSLASH: '\\',
  TILDE: '~',
};

const PRELUDE = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

/** The playback position, in seconds. */
uniform float u_time;
/** The score (see score.ts), and how many steps it has. */
uniform highp sampler2D u_score;
uniform int u_steps;
/** The window, a cell, and the player's box (left, top, right, bottom), in CSS pixels. */
uniform vec2 u_view;
uniform vec2 u_cell;
uniform vec4 u_player;
/** Columns and rows. */
uniform ivec2 u_grid;
/** The effect's lines of text, as glyphs four to a vector; where each line starts, and how long. */
uniform ivec4 u_text[64];
uniform ivec2 u_texts[4];

const float PI = 3.14159265;
const float STEP = ${TRACK_MAP_STEP};
${Object.entries(GLYPHS)
  .map(([name, char]) => `const int ${name} = ${glyphSlot(char)};`)
  .join('\n')}

struct Cell { int glyph; vec3 colour; float alpha; };
const Cell NOTHING = Cell(SPACE, vec3(0), 0.);

/** Shows a glyph in the cell over whatever it had, if it shows at all. */
void put(inout Cell cell, int glyph, vec3 colour, float alpha) {
  if (glyph != SPACE && alpha > 0.02) cell = Cell(glyph, colour, min(alpha, 1.));
}

// The score.

vec4 texel(int row, int moment) {
  int index = clamp(moment, 0, u_steps - 1) * ${ROWS} + row;
  return texelFetch(u_score, ivec2(index % ${SCORE_WIDTH}, index / ${SCORE_WIDTH}), 0);
}

vec4 curve(int row, float time) {
  float at = clamp(time / STEP, 0., float(u_steps - 1));
  int first = int(at);
  return mix(texel(row, first), texel(row, first + 1), at - float(first));
}

struct Music { float bass, mid, treble, calm, flare, pulse, glint, overflow, charge; vec3 spun; };

/** The music at a moment of the song (see score.ts). */
Music musicAt(float time) {
  vec4 levels = curve(0, time), hits = curve(1, time), turns = curve(2, time);
  return Music(levels.x, levels.y, levels.z, levels.w, hits.x, hits.y, hits.z, hits.w, turns.w, turns.xyz);
}

const int KICK = 3, SNARE = 4, PEAK = 5, HAT = 6;
/** A kick, snare, peak, or hi-hat: when it started and ends, how strong, and which (counting from 1). */
struct Event { float start, end, strength; int index; };

/** The latest KICK, SNARE, PEAK, or HAT by \`time\`, or one long ago (index 0) if there is none. */
Event latest(int kind, float time) {
  vec4 event = texel(kind, int(floor(time / STEP)));
  if (event.x > time) return Event(-1e6, -1e6, 0., 0);
  return Event(event.x, event.y, event.z, int(event.w));
}

/** The one before it. */
Event before(int kind, Event event) {
  return latest(kind, event.start - STEP / 2.);
}

/** How strong the peak at \`time\` is, or 0 outside peaks. */
float powerAt(float time) {
  Event peak = latest(PEAK, time);
  return time < peak.end ? peak.strength : 0.;
}

// Around the player.

/** How far p is outside the player's box, as a vector (0 inside). */
vec2 outside(vec2 p) {
  return p - clamp(p, u_player.xy, u_player.zw);
}

/** How long the ring round the player at \`d\` px out is: a box with rounded corners. */
float perimeter(float d) {
  vec2 size = u_player.zw - u_player.xy;
  return 2. * (size.x + size.y) + 2. * PI * d;
}

/** How far along the ring through p it is, in px, clockwise from the left of its top-left corner. */
float around(vec2 p) {
  vec2 size = u_player.zw - u_player.xy, off = outside(p);
  float d = length(off), quarter = d * PI / 2.;
  if (off.x < 0. && off.y < 0.) return d * atan(-off.y, -off.x);
  if (off.y < 0. && off.x == 0.) return quarter + p.x - u_player.x;
  if (off.x > 0. && off.y < 0.) return quarter + size.x + d * atan(off.x, -off.y);
  if (off.x > 0. && off.y == 0.) return 2. * quarter + size.x + p.y - u_player.y;
  if (off.x > 0. && off.y > 0.) return 2. * quarter + size.x + size.y + d * atan(off.y, off.x);
  if (off.y > 0. && off.x == 0.) return 3. * quarter + size.x + size.y + u_player.z - p.x;
  if (off.x < 0. && off.y > 0.) return 3. * quarter + 2. * size.x + size.y + d * atan(-off.x, off.y);
  return 4. * quarter + 2. * size.x + size.y + u_player.w - p.y;
}

/** The point \`u\` (0 to 1) of the way round the ring \`d\` px out from the player. */
vec2 pointAround(float u, float d) {
  vec2 size = u_player.zw - u_player.xy;
  float quarter = d * PI / 2., along = fract(u) * perimeter(d);
  if (along < quarter) return u_player.xy - d * vec2(cos(along / d), sin(along / d));
  along -= quarter;
  if (along < size.x) return vec2(u_player.x + along, u_player.y - d);
  along -= size.x;
  if (along < quarter) return u_player.zy + d * vec2(sin(along / d), -cos(along / d));
  along -= quarter;
  if (along < size.y) return vec2(u_player.z + d, u_player.y + along);
  along -= size.y;
  if (along < quarter) return u_player.zw + d * vec2(cos(along / d), sin(along / d));
  along -= quarter;
  if (along < size.x) return vec2(u_player.z - along, u_player.w + d);
  along -= size.x;
  if (along < quarter) return u_player.xw + d * vec2(-sin(along / d), cos(along / d));
  return vec2(u_player.x - d, u_player.w - (along - quarter));
}

// Drawing.

/**
 * How far from a line a cell may be and still draw it, measured at \`angle\` across the line, so
 * lines and rings come out one cell thick without gaps: half a cell, which is taller than wide.
 */
float tolerance(float angle) {
  return 0.5 * max(abs(sin(angle)) * u_cell.y, abs(cos(angle)) * u_cell.x);
}

/** The glyph that draws a line at \`angle\` (radians, y down). */
int lineGlyph(float angle) {
  float slope = mod(angle, PI);
  if (slope < PI / 8. || slope > PI * 7. / 8.) return DASH;
  if (slope < PI * 3. / 8.) return BACKSLASH;
  if (slope < PI * 5. / 8.) return BAR;
  return SLASH;
}

/** Whether the line from \`start\` out at \`angle\` runs through the cell at p. */
bool onLine(vec2 p, vec2 start, float angle) {
  vec2 direction = vec2(cos(angle), sin(angle)), off = p - start;
  return dot(off, direction) >= 0. && abs(off.x * direction.y - off.y * direction.x) <= tolerance(angle + PI / 2.);
}

/** How long one of the effect's lines of text is. */
int textLength(int text) {
  return u_texts[text].y;
}

/** The glyph at \`index\` in one of the effect's lines of text, which repeats. */
int textGlyph(int text, float index) {
  ivec2 line = u_texts[text];
  if (line.y == 0) return SPACE;
  int at = line.x + int(mod(floor(index), float(line.y)));
  return u_text[at / 4][at % 4];
}

// Chance.

uvec3 pcg(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

/** A repeatable random number from 0 up to 1 for up to three integers. */
float random(int a, int b, int c) {
  return float(pcg(uvec3(ivec3(a, b, c))).x >> 8u) / 16777216.;
}
float random(int a, int b) { return random(a, b, 0); }
float random(int a) { return random(a, 0, 0); }
float random(ivec2 at, int seed) { return random(at.x, at.y, seed); }

/** Repeatable noise from 0 to 1 over the plane, smooth between whole coordinates. */
float valueNoise(vec2 p) {
  ivec2 corner = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(
    mix(random(corner, 7), random(corner + ivec2(1, 0), 7), f.x),
    mix(random(corner + ivec2(0, 1), 7), random(corner + ivec2(1, 1), 7), f.x),
    f.y
  );
}

/** Noise in octaves, finer detail over broad shapes, from 0 to 1. */
float fbm(vec2 p) {
  float sum = 0., weight = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    sum += weight * valueNoise(p);
    p = p * 2.03 + 17.1;
    weight *= 0.5;
  }
  return sum / 0.9375;
}

/** The glyph for how dense something is, from nothing at 0 up through . : - = + * # % to @ at 1. */
int shade(float amount) {
  const int RAMP[9] = int[9](DOT, COLON, DASH, EQUALS, PLUS, STAR, HASH, PERCENT, ATSIGN);
  return amount <= 0. ? SPACE : RAMP[clamp(int(amount * 9.), 0, 8)];
}

/**
 * A cell's own turns: its time cut into stretches \`span\` seconds long, at its own offset. Returns
 * when this one started, how far through it the cell is (0 to 1), and a random number for it; a
 * cell that sparkles when that number is under some chance sparkles at random, as often as the
 * music (read at the start) makes the chance.
 */
vec3 turn(ivec2 at, int seed, float span) {
  float offset = random(at, seed);
  float index = floor(u_time / span + offset);
  float start = (index - offset) * span;
  return vec3(start, (u_time - start) / span, random(at.x, at.y, int(index) * 64 + seed));
}

/**
 * A field of particles drifting at \`velocity\` (px/s), one to each \`spacing\` px square, each
 * showing for \`life\` seconds of every \`period\`. Returns the one in the cell at p: when it
 * appeared, how long ago, and a random number for it (to decide whether it shows at all, against
 * the music when it appeared); or an age of -1 if none is in the cell.
 */
vec3 drifter(vec2 p, vec2 velocity, float spacing, float period, float life, int seed) {
  vec2 q = p - velocity * u_time;
  ivec2 home = ivec2(floor(q / spacing));
  vec2 margin = u_cell * 0.5;
  vec2 spot = vec2(home) * spacing + margin + vec2(random(home, seed), random(home, seed + 1)) * (spacing - 2. * margin);
  if (any(greaterThan(abs(spot - q), margin))) return vec3(0, -1, 0);
  float shifted = u_time + random(home, seed + 2) * period;
  float cycle = floor(shifted / period);
  float age = shifted - cycle * period;
  if (age > life) return vec3(0, -1, 0);
  return vec3(u_time - age, age, random(home.x * 16 + seed, home.y, int(cycle)));
}

/**
 * Sparks flung out all round the player \`age\` seconds ago, slowing as they fly: one on each of
 * 160 rays by chance \`density\`, each at its own speed from \`speed.x\` to \`speed.y\` px/s. Returns
 * a random number for the one in the cell at p, or -1 if none is.
 */
float burst(vec2 p, float age, int seed, float density, vec2 speed, float drag) {
  const int RAYS = 160;
  float d = length(outside(p));
  int ray = int(around(p) / perimeter(d) * float(RAYS));
  for (int next = ray - 1; next <= ray + 1; next++) {
    int r = (next + RAYS) % RAYS;
    if (random(r, seed, 1) >= density) continue;
    float reach = mix(speed.x, speed.y, random(r, seed, 2)) * (1. - exp(-age * drag)) / drag;
    vec2 spark = pointAround((float(r) + 0.5) / float(RAYS), reach);
    if (all(lessThanEqual(abs(spark - p), u_cell * 0.5))) return random(r, seed, 3);
  }
  return -1.;
}
`;

const MAIN = /* glsl */ `
/** The canvas and a cell, in device pixels. */
uniform vec2 u_pixels;
uniform vec2 u_cellPixels;

/** Where the cell's glyph is in the atlas, in pixels, and its colour, premultiplied. */
flat out ivec2 v_glyph;
flat out vec4 v_colour;

void main() {
  ivec2 at = ivec2(gl_VertexID % u_grid.x, gl_VertexID / u_grid.x);
  vec2 p = (vec2(at) + 0.5) * u_cell;
  gl_PointSize = max(u_cellPixels.x, u_cellPixels.y);
  // Off screen, unless it shows something outside the player.
  gl_Position = vec4(-2, -2, 0, 1);
  v_glyph = ivec2(0);
  v_colour = vec4(0);
  if (length(outside(p)) == 0.) return;
  Cell cell = draw(p, at);
  if (cell.alpha == 0.) return;
  gl_Position = vec4((vec2(at) + 0.5) * u_cellPixels / u_pixels * vec2(2, -2) + vec2(-1, 1), 0, 1);
  v_glyph = ivec2(cell.glyph % ${ATLAS_COLUMNS}, cell.glyph / ${ATLAS_COLUMNS}) * ivec2(u_cellPixels);
  v_colour = vec4(cell.colour, 1) * cell.alpha;
}
`;

/** Each cell is drawn as a point as big as the cell's longer side, showing its glyph from the atlas. */
export const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D u_atlas;
uniform vec2 u_cellPixels;
flat in ivec2 v_glyph;
flat in vec4 v_colour;
out vec4 colour;

void main() {
  float size = max(u_cellPixels.x, u_cellPixels.y);
  vec2 pixel = gl_PointCoord * size - (size - u_cellPixels) / 2.;
  if (any(lessThan(pixel, vec2(0))) || any(greaterThanEqual(pixel, u_cellPixels))) discard;
  colour = v_colour * texelFetch(u_atlas, v_glyph + ivec2(pixel), 0).a;
}
`;

export function vertexShader(effect: Effect) {
  return [PRELUDE, effect.shader, MAIN].join('\n');
}
