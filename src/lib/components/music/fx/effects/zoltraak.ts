import { rgb, type Effect } from '../shader';

/**
 * Zoltraak, from inside: flying down a tunnel of magic whose far end is the player, its walls
 * the player's outline repeating into the distance.
 *
 * - Bass: flying faster as the bass is louder, and on every kick a ring of light rushing up the
 *   tunnel past you.
 * - Mid: the tunnel turns, and its lines brighten with the mids.
 * - Treble: runes on the walls flicker and shine.
 * - Calm stretches: drifting slowly through a dim tunnel.
 * - Peaks: light gathers round the player in the seconds before, then a warp: a great leap down
 *   the tunnel, streaks rushing past, and through the peak it burns hot.
 */
export const zoltraak: Effect = {
  id: 'zoltraak',
  name: 'Zoltraak',
  background: '#0a0916',
  dark: true,
  flash: '#e9e2ff',
  texts: ({ title, artist }) => [`${title || 'ZOLTRAAK'} · ${artist || 'FERN'} · `, '<>^~*=+#%&§/\\|:'],
  shader: /* glsl */ `
const vec3 WALL = ${rgb('#3a3170')};
const vec3 LINE = ${rgb('#6a5fd0')};
const vec3 RUNE = ${rgb('#b3a6ff')};
const vec3 RING = ${rgb('#7fe3ff')};
const vec3 HOT = ${rgb('#ff5fd2')};
const vec3 WHITE = ${rgb('#f4f8ff')};
/** How deep the tunnel looks, and how many lines run along it. */
const float DEPTH = 400., LINES = 24.;
/** Pixels out from the player where the tunnel's far end is, so it does not all crowd onto its edge. */
const float MOUTH = 12.;
/** How deep a kick's ring of light starts, and how fast it rushes up the tunnel (depth per second). */
const float FAR = 16., RUSH = 22.;

Cell draw(vec2 p, ivec2 at) {
  Cell cell = NOTHING;
  Music now = musicAt(u_time);
  vec2 off = outside(p);
  float d = length(off), angle = atan(off.y, off.x), slack = tolerance(angle), along = around(p);
  Event peak = latest(PEAK, u_time);
  float since = u_time - peak.start, bang = 0.6 + peak.strength * 0.4;
  // A peak comes in with a warp: a great leap down the tunnel, easing off.
  float warp = since < 3. ? exp(-since / 0.5) * bang : 0.;
  float leap = (float(peak.index) - exp(-since / 0.5)) * 25.;
  float travel = now.spun.x * 0.8 + leap;
  // How deep into the tunnel the cell looks: far by the player, near at the window's edges.
  float z = DEPTH / (d + MOUTH), v = z + travel;
  float fog = exp(-z / 7.) * (1. - now.calm * 0.5);
  float hot = clamp(now.overflow * 1.5 + warp, 0., 1.);
  // Round the tunnel, from 0 to 1, turning with the mids.
  float u = fract(along / perimeter(d) + now.spun.y * 0.004);

  // Treble: runes on the walls, one in the middle of some of their panels, flickering and shining.
  float across = LINES * 3., rows = floor(v * 3.), column = floor(u * across);
  float panel = random(int(rows), int(column), 5);
  float runeZ = (rows + 0.5) / 3. - travel;
  vec2 rune = pointAround((column + 0.5) / across - now.spun.y * 0.004, DEPTH / max(runeZ, 0.01) - MOUTH);
  if (panel < 0.15 && runeZ > 0. && all(lessThanEqual(abs(rune - p), u_cell * 0.5)))
    put(cell, textGlyph(1, panel * 4096. + floor(now.spun.z * 2.)), mix(WALL, RUNE, now.treble), exp(-runeZ / 7.) * (0.4 + now.treble * 0.6 + now.glint * 0.4));

  // The lines along the tunnel.
  float line = u * LINES;
  if (abs(line - round(line)) * perimeter(d) / LINES <= tolerance(angle + PI / 2.))
    put(cell, lineGlyph(angle), mix(LINE, HOT, hot * 0.5), fog * (0.35 + now.mid * 0.5 + now.pulse * 0.3));

  // Its rings, one per unit of depth, every fourth written with the song's title.
  float ringV = round(v), ringZ = ringV - travel;
  if (ringZ > 0. && abs(d - (DEPTH / ringZ - MOUTH)) <= slack) {
    bool titled = mod(ringV, 4.) == 0.;
    float bright = exp(-ringZ / 7.) * (0.45 + now.bass * 0.3 + now.flare * 0.5) * (1. - now.calm * 0.5);
    put(cell, titled ? textGlyph(0, along / u_cell.x) : lineGlyph(angle + PI / 2.), titled ? RUNE : mix(LINE, RING, now.flare), bright);
  }

  // Each kick sends a ring of light rushing up the tunnel: the one that has reached this deep.
  float nearest = DEPTH / (d + slack + MOUTH), farthest = DEPTH / max(d - slack + MOUTH, 1.);
  Event kick = latest(KICK, min(u_time, u_time - (FAR - farthest) / RUSH));
  if (kick.start >= u_time - (FAR - nearest) / RUSH) {
    int glyph = lineGlyph(angle + PI / 2.);
    float kickZ = FAR - (u_time - kick.start) * RUSH;
    put(cell, glyph == DASH ? EQUALS : glyph, mix(RING, HOT, hot), kick.strength * (0.5 + 0.8 * exp(-kickZ / 5.)));
  }

  // Warping: streaks rushing past.
  float streak = random(int(u * 240.), int(floor(v * 1.5)), 9);
  if (streak < warp * 0.45) put(cell, lineGlyph(angle), WHITE, warp * (0.4 + fog));

  // Light gathering round the player before a peak, and burning there through it.
  float core = (now.charge * 1.2 + now.overflow * 0.4 + warp) * exp(-d / (20. + now.charge * 90. + warp * 160.));
  if (core > 0.12) put(cell, shade(min(core, 1.)), mix(RUNE, WHITE, min(core, 1.)), core);
  return cell;
}
`,
};
