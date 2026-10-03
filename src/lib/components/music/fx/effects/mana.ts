import { rgb, type Effect } from '../shader';

/**
 * Mana, cast from the player. It all radiates from the player's box:
 *
 * - Bass: a haze of mana around the player, flowing outward, and on every kick a ripple: the
 *   player's outline, spreading out across the background.
 * - Mid: an inscription running around the player like the rings of a magic circle (the song's
 *   title and artist), turning with the mids and brightening on snares and chords.
 * - Treble: mana glinting in the haze on the hi-hats.
 * - Calm stretches: the haze settles and motes rise off the player.
 * - Peaks: the mana gathers close around the player in the seconds before, then overflows. A
 *   great ripple crosses the background and sparks burst out, the haze floods it and burns warm,
 *   and a third ring of the inscription opens.
 */
export const mana: Effect = {
  id: 'mana',
  name: 'Mana',
  background: '#f4f4ef',
  flash: '#ffd6bd',
  texts: ({ title, artist, album }) => [
    `${title || 'MANA'} · ${artist || 'FERN'} · `,
    '-----+',
    `${album || title || 'ZOLTRAAK'} // `,
  ],
  shader: /* glsl */ `
const vec3 BLUE = ${rgb('#8fa7c9')};
const vec3 DEEP = ${rgb('#4f73b3')};
const vec3 VIOLET = ${rgb('#7a5fa8')};
const vec3 WARM = ${rgb('#ff8a4f')};
const vec3 ORANGE = ${rgb('#ff5a1f')};
const vec3 INK = ${rgb('#5c5c58')};
const vec3 FAINT = ${rgb('#c4c4bb')};
const vec3 GLOW = ${rgb('#ffb08a')};
/** Pixels per second a kick's ripple travels, and a peak's great ripple. */
const float RIPPLE = 520., GREAT_RIPPLE = 1300.;

/** A ring of the inscription: a line of text running round the player \`rows\` rows out. */
void ring(inout Cell cell, vec2 p, float rows, int text, float scroll, vec3 colour, float alpha) {
  vec2 off = outside(p);
  float angle = atan(off.y, off.x);
  if (abs(length(off) - rows * u_cell.y) > tolerance(angle)) return;
  int glyph = textGlyph(text, (around(p) - scroll) / u_cell.x);
  put(cell, glyph == DASH ? lineGlyph(angle + PI / 2.) : glyph, colour, alpha);
}

Cell draw(vec2 p, ivec2 at) {
  Cell cell = NOTHING;
  Music now = musicAt(u_time);
  vec2 off = outside(p);
  float d = length(off), angle = atan(off.y, off.x), along = around(p), slack = tolerance(angle);
  float warm = smoothstep(0.25, 0.35, now.overflow);

  // The haze: how far it reaches and how strong it is. It settles when calm, gathers in close
  // before a peak, and floods out in it.
  float reach = (70. + now.bass * 320. + now.flare * 140. + now.overflow * 500.) * (1. - now.charge * 0.6);
  float strength = ((0.25 + now.bass * 0.6 + now.flare * 0.5) * (1. - now.calm * 0.6) + now.overflow * 0.3 + now.charge * 0.5);
  float energy = strength * exp(-d / reach) * (0.3 + valueNoise(vec2(along / 90., d / 60. - u_time * 1.2)));
  if (energy >= 0.05) put(cell, energy > 0.45 ? COLON : DOT, energy > 0.3 ? mix(DEEP, ORANGE, warm) : mix(BLUE, WARM, warm), energy * 1.6);

  // Each kick's ripple: the player's outline, one cell thick, as far out as it has spread.
  Event kick = latest(KICK, u_time - (d - slack) / RIPPLE);
  float age = u_time - kick.start;
  if (abs(d - age * RIPPLE) <= slack && age < 2.5) put(cell, lineGlyph(angle + PI / 2.), mix(DEEP, WARM, warm), min(1., 0.3 + kick.strength) * exp(-age / 0.8));

  // Calm: motes rising off the player.
  vec3 mote = drifter(p, vec2(0, -14), 70., 8., 6., 11);
  float chance = mote.y < 0. ? 0. : max(0., musicAt(mote.x).calm - 0.3) * 3. * exp(-length(outside(p + vec2(0, 14) * mote.y)) / 80.);
  if (mote.z < chance) put(cell, mote.z < chance * 0.3 ? STAR : DOT, mote.z < chance * 0.5 ? BLUE : DEEP, min(1., mote.y) * (1. - mote.y / 6.) * 0.8);

  // Treble: mana glinting in the haze, a cross of light fading to a dot.
  vec3 glint = turn(at, 21, 0.7);
  Music then = musicAt(glint.x);
  chance = (then.glint * 0.6 + then.treble * 0.15) * (1. - then.calm * 0.5) * exp(-d / reach) * 0.01;
  float moment = glint.y * 0.7;
  if (glint.z < chance) put(cell, moment < 0.08 ? PLUS : moment < 0.3 ? STAR : moment < 0.45 ? PLUS : DOT, mix(DEEP, GLOW, warm), (0.5 + then.glint * 0.5) * (1. - glint.y));

  // The inscription, and a third ring opening as a peak overflows.
  float opening = min(1., now.overflow * 2.);
  ring(cell, p, 1.5, 0, now.spun.y * 10., INK, (0.3 + now.mid * 0.6 + now.pulse * 0.5) * (1. - now.calm * 0.5) + now.charge * 0.5);
  ring(cell, p, 3., 1, -now.spun.z * 8., FAINT, 0.25 + now.treble * 0.5 + now.charge * 0.5);
  ring(cell, p, 2. + opening * 3., 2, now.spun.x * 12., VIOLET, opening);

  // A peak comes in with a great ripple, four outlines deep, and sparks bursting out.
  Event peak = latest(PEAK, u_time);
  float since = u_time - peak.start, bang = 0.6 + peak.strength * 0.4;
  for (int echo = 0; echo < 4 && since < 3.; echo++) {
    float front = since * GREAT_RIPPLE - float(echo) * u_cell.y * 1.2;
    int glyph = lineGlyph(angle + PI / 2.);
    if (front > 0. && abs(d - front) <= slack) put(cell, glyph == DASH ? EQUALS : glyph, mix(VIOLET, ORANGE, warm), exp(-since / 1.2) * (1. - float(echo) * 0.2));
  }
  float spark = since < 1.6 ? burst(p, since, peak.index, (40. + bang * 60.) / 160., vec2(500, 1400), 2.5) : -1.;
  if (spark >= 0.) put(cell, since < 0.5 ? STAR : PLUS, spark < 0.5 ? ORANGE : WARM, (1. - since / 1.6) * (0.4 + bang * 0.6));
  return cell;
}
`,
};
