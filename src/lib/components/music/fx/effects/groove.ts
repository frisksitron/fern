import { glyphSlot, rgb, type Effect } from '../shader';

/**
 * Groove: the whole song at once, a band of stars spiralling in round the player like a magic
 * circle seen aslant, start at the outside, end by the player, as wide as the music is loud, with
 * an orb of mana playing along it. What has played burns in colour; what is to come lies dim
 * ahead, but its shape is all there, so a chorus can be seen coming a loop away.
 *
 * - Bass: the band swells in towards the player. The orb swells with it, and on every kick
 *   throbs, bursting out and springing back in, throwing off sparks. The orb moves the groove,
 *   not the other way round: it holds the groove back round it, and each throb runs out through
 *   the groove, pushing it out and letting it back in as it passes.
 * - Mid and treble: the band swells out, away from the player; the runes of the orb's spell
 *   circle flare on the snares.
 * - Calm stretches: the groove runs thin, and the orb settles.
 * - Peaks: gold along the groove, pulsing as they near. Before one, mana streams into the orb and
 *   it gathers in on itself; as it comes in, the orb blazes up, a shockwave leaves it, and the
 *   whole groove flashes. Then, all along the golden path, the orb's throbs set the whole groove
 *   dancing, and rings of colour run out from it.
 * - Round it all, the rest of the galaxy: stars wheeling round the player, twinkling with the
 *   hi-hats, the orb's throbs running through them too, and now and then a shooting star.
 */
export const groove: Effect = {
  id: 'groove',
  name: 'Groove',
  background: '#0c0a18',
  dark: true,
  flash: '#e6dcff',
  texts: () => ['ΛΞΠΣΦΨΩΓΘЖЮЯЂЋЏЉ†‡§◊', '∙•●'],
  shader: /* glsl */ `
const vec3 LOW = ${rgb('#8a6bff')};
const vec3 HIGH = ${rgb('#7fd4ff')};
const vec3 HOT_LOW = ${rgb('#ff6fae')};
const vec3 HOT_HIGH = ${rgb('#ffc76b')};
const vec3 DIM = ${rgb('#524c8a')};
const vec3 DIM_PEAK = ${rgb('#96723a')};
const vec3 NEAR = ${rgb('#c9d4ff')};
const vec3 LABEL = ${rgb('#6d6891')};
const vec3 WHITE = ${rgb('#ffffff')};
const vec3 NIGHT = ${rgb('#2c1f73')};
const vec3 VIOLET = ${rgb('#7d5cff')};
const vec3 LILAC = ${rgb('#d4c6ff')};
const vec3 RIM = ${rgb('#8fe3ff')};
const vec3 GOLD = ${rgb('#ffd27a')};
const int ZERO = ${glyphSlot('0')};
/** Loops in the groove; the gap round the player (px); how wide the band gets against its loops. */
const float LOOPS = 2., INNER = 36., WIDTH = 0.9;
/** Seconds of the groove ahead of the orb that it lights; how big the orb is (px). */
const float AHEAD = 8., ORB = 36.;

/** A rune, and a dot from the smallest (0) to the biggest (2). */
int rune(float index) { return textGlyph(0, floor(random(int(floor(index)), 7) * float(textLength(0)))); }
int speck(float size) { return textGlyph(1, clamp(size, 0., 2.)); }

/**
 * The groove: the player's middle, its outer loop's half width and height, and how far in its
 * loops reach from there (px); the song's length (s), and how long its outer and inner loops are.
 */
vec2 centre, outer;
float band, song, first, last;

/** An ellipse's circumference, near enough (Ramanujan's). */
float circumference(vec2 axes) {
  return PI * (3. * (axes.x + axes.y) - sqrt((3. * axes.x + axes.y) * (axes.x + 3. * axes.y)));
}

/**
 * Lays the groove out filling the window round the player: its inner loop just clear of the
 * player's corners, with as much room across its loops at the sides as above and below.
 */
void fit() {
  song = max(float(u_steps) * STEP, 1.);
  centre = (u_player.xy + u_player.zw) / 2.;
  vec2 corner = (u_player.zw - u_player.xy) / 2. + INNER;
  vec2 room = min(centre, u_view - centre) - vec2(2. * u_cell.x, u_cell.y);
  float lo = 0.02, hi = PI / 2. - 0.02;
  for (int i = 0; i < 16; i++) {
    float slant = (lo + hi) / 2.;
    vec2 through = corner / vec2(cos(slant), sin(slant));
    if (room.x - through.x > room.y - through.y) lo = slant;
    else hi = slant;
  }
  vec2 inner = corner / vec2(cos(lo), sin(lo));
  // Leaving room outside the outer loop for its band.
  band = max(min(room.x - inner.x, room.y - inner.y) / (1. + 0.5 * WIDTH / LOOPS), u_cell.y * 2. * LOOPS);
  outer = inner + band;
  first = circumference(outer);
  last = circumference(inner);
}

/**
 * \`age\` seconds after a kick, how far the orb has swelled out: bursting out, and springing back
 * in past where it rests.
 */
float throb(float age) { return age < 1.5 ? (1. - exp(-age * 30.)) * exp(-age * 4.) * cos(age * 14.) : 0.; }

/**
 * The orb, and how it moves the groove: where it is; how far it holds the groove back from it,
 * and how far its throbs push the groove as they run out through it (px); and how much it is
 * dancing, on the golden path.
 */
vec2 orb;
float hollow, shake, dancing;
/** How fast its throbs run out through the groove (px/s). */
const float RIPPLE = 420.;

/**
 * How the orb's throbs have pushed the groove at p: each one runs out from it through the groove,
 * pushing it out and letting it back in as it passes. Returns how far (px, away from the orb),
 * and how hard the throb just past hit.
 */
vec3 rippled(vec2 p) {
  vec2 off = p - orb;
  float d = max(length(off), 0.001), left = u_time - d / RIPPLE;
  Event kick = latest(KICK, left);
  float age = left - kick.start, fading = exp(-d / 1400.) * smoothstep(0., 40., d);
  return vec3(off / d * kick.strength * throb(age) * shake * fading, kick.strength * exp(-age / 0.2) * fading);
}

/** Where a point of the groove lying still ends up, held back by the orb and pushed by its throbs; and back. */
vec2 pushed(vec2 p) {
  vec2 off = p - orb;
  float d = length(off);
  if (d > 0.001) p = orb + off / d * sqrt(d * d + hollow * hollow);
  return p + rippled(p).xy;
}
vec2 unpushed(vec2 p) {
  vec2 still = p - rippled(p).xy;
  still = p - rippled(still).xy;
  vec2 off = still - orb;
  float d = length(off);
  return d <= hollow ? vec2(-1e5) : orb + off / d * sqrt(d * d - hollow * hollow);
}

/** How far along the groove (px) it is \`s\` loops in, each loop shorter than the one outside it, and at what time of the song. */
float lengthAt(float s) { return first * s - (first - last) * s * s / (2. * LOOPS); }
float timeAt(float s) { return lengthAt(s) / lengthAt(LOOPS) * song; }
/** How many loops in the groove is at \`time\`. */
float loopsAt(float time) {
  float a = (first - last) / (2. * LOOPS), x = clamp(time / song, 0., 1.) * lengthAt(LOOPS);
  return a < 0.001 ? x / first : (first - sqrt(max(first * first - 4. * a * x, 0.))) / (2. * a);
}
/** The point \`s\` loops along the groove, \`side\` px out from it. It starts at the top, and runs clockwise. */
vec2 pointOn(float s, float side) {
  float turn = 2. * PI * s - PI / 2.;
  return centre + (outer - band * s / LOOPS + side) * vec2(cos(turn), sin(turn));
}

/**
 * Where p is on the groove: how many loops in, how far out from the groove's middle (px), and the
 * angle across the groove there.
 */
vec3 placeOf(vec2 p) {
  vec2 off = p - centre, inner = outer - band;
  // The ellipse through p among the groove's: its half width and height are the inner loop's and
  // as much again.
  float lo = 0.5 - min(inner.x, inner.y), hi = length(off);
  for (int i = 0; i < 20; i++) {
    float t = (lo + hi) / 2.;
    vec2 e = off / (inner + t);
    if (dot(e, e) > 1.) lo = t;
    else hi = t;
  }
  float t = (lo + hi) / 2.;
  vec2 axes = inner + t, e = off / axes, normal = off / (axes * axes);
  float u = fract(atan(e.y, e.x) / (2. * PI) + 0.25);
  float s = round((1. - t / band) * LOOPS - u) + u;
  return vec3(s, t - band * (1. - s / LOOPS), atan(normal.y, normal.x));
}

vec2 rotate(vec2 v, float angle) {
  return vec2(v.x * cos(angle) - v.y * sin(angle), v.x * sin(angle) + v.y * cos(angle));
}

/**
 * The sky behind the groove, the rest of a galaxy round it, at p (\`lying\` where it would be but
 * for the orb's throbs, which run through the sky as through the groove): stars in three layers,
 * the farther smaller, fainter, and slower, all wheeling round the player, faster with the bass;
 * twinkling, some glinting on the hi-hats, and lighting up as each throb passes; faint dust
 * drifting; and now and then a shooting star, more often the more is going on.
 */
void sky(inout Cell cell, vec2 p, vec2 lying, ivec2 at, Music now, float hit) {
  float wheel = u_time * 0.025 + now.spun.x * 0.015;
  Event hat = latest(HAT, u_time);
  float glint = exp(-(u_time - hat.start) / 0.2) * hat.strength;

  float dust = fbm(rotate(lying - centre, -wheel * 0.3) / 240. + 5.);
  if (dust > 0.58 && random(at, 51) < (dust - 0.55) * 2.)
    put(cell, DOT, mix(NIGHT, VIOLET, (dust - 0.58) * 3.), (dust - 0.58) * 1.5 + hit * 0.2);

  for (int layer = 0; layer < 3; layer++) {
    float far = float(layer), size = 44. + far * 20., turned = wheel / (1. + far);
    ivec2 home = ivec2(floor((centre + rotate(lying - centre, -turned)) / size));
    if (random(home, 60 + layer) > 0.45) continue;
    vec2 spot = (vec2(home) + 0.15 + 0.7 * vec2(random(home, 61 + layer * 3), random(home, 62 + layer * 3))) * size;
    if (any(greaterThan(abs(centre + rotate(spot - centre, turned) - lying), u_cell * 0.5))) continue;
    float kind = random(home, 63 + layer * 3);
    float twinkle = 0.55 + 0.45 * sin(u_time * (1.5 + kind * 3.) + kind * 40.);
    float bright = (0.55 - far * 0.15) * twinkle + (kind < 0.3 ? glint * 0.6 : 0.) + hit * 0.5;
    int glyph = layer == 0 ? (kind < 0.15 ? STAR : kind < 0.45 ? PLUS : speck(0.)) : layer == 1 ? (kind < 0.2 ? PLUS : speck(0.)) : DOT;
    put(cell, glyph, kind < 0.1 ? GOLD : kind < 0.55 ? NEAR : LILAC, bright);
  }

  for (int back = 0; back < 2; back++) {
    float window = floor(u_time / 1.5) - float(back);
    int id = int(window);
    float start = (window + random(id, 71) * 0.6) * 1.5, age = u_time - start;
    Music then = musicAt(start);
    if (age < 0. || age > 0.7 || random(id, 72) > 0.1 + then.treble * 0.3 + dancing * 0.4) continue;
    float heading = PI * (0.12 + random(id, 75) * 0.2);
    vec2 direction = vec2(random(id, 76) < 0.5 ? cos(heading) : -cos(heading), sin(heading));
    vec2 off = p - (vec2(random(id, 73), random(id, 74) * 0.6) * u_view + direction * age * 900.);
    float behind = -dot(off, direction);
    if (behind >= 0. && behind < 90. && abs(off.x * direction.y - off.y * direction.x) <= tolerance(atan(direction.y, direction.x) + PI / 2.))
      put(cell, behind < 10. ? STAR : lineGlyph(atan(direction.y, direction.x)), NEAR, (1. - behind / 90.) * (1. - age / 0.7));
  }
}

/** The loudest the bass, and the mid or treble, get over \`span\` seconds round \`time\`. */
vec2 loudest(float time, float span) {
  vec2 most = vec2(0);
  for (int i = -1; i <= 1; i++) {
    Music then = musicAt(time + float(i) * span / 3.);
    most = max(most, vec2(then.bass, max(then.mid, then.treble)));
  }
  return most;
}

Cell draw(vec2 p, ivec2 at) {
  Cell cell = NOTHING;
  fit();
  Music now = musicAt(u_time);
  float spacing = band / LOOPS;
  // Seconds of song a cell along the groove holds.
  float span = max(u_cell.x, u_cell.y) * 0.7 / (lengthAt(LOOPS) / song);
  Event peak = latest(PEAK, u_time);
  float since = u_time - peak.start, bang = 0.6 + peak.strength * 0.4;
  float blaze = since < 2.5 ? bang * exp(-since / 0.5) : 0.;
  Event kick = latest(KICK, u_time), snare = latest(SNARE, u_time);
  float age = u_time - kick.start, struck = exp(-(u_time - snare.start) / 0.25) * snare.strength;
  dancing = u_time < peak.end ? smoothstep(0., 0.6, u_time - peak.start) * smoothstep(0., 1., peak.end - u_time) : 0.;
  
  // The orb, playing: a sphere of mana swelling with the bass, and on every kick throbbing,
  // bursting out and springing back in; gathering in on itself before a peak, and blazing up as
  // one comes in. It holds the groove back round it, and its throbs run out through the groove,
  // gently, until on the golden path they set the whole of it dancing.
  orb = pointOn(loopsAt(u_time), 0.);
  float radius = ORB * (1. + now.bass * 0.35 + now.flare * 0.2 + kick.strength * throb(age) * 0.7 + blaze * 0.8 + 0.05 * sin(u_time * 4.)) * (1. - now.charge * 0.3);
  hollow = radius * 0.9;
  shake = 8. + 26. * dancing;

  // The groove.
  float hit = rippled(p).z;
  vec2 lying = unpushed(p);
  sky(cell, p, lying, at, now, hit);
  vec3 place = placeOf(lying);
  float s = place.x, side = place.y;
  if (s >= 0. && s <= LOOPS) {
    float time = timeAt(s);
    vec2 level = loudest(time, span);
    float loud = side < 0. ? level.x : level.y;
    float amp = (0.15 + 0.85 * loud) * spacing * 0.5 * WIDTH;
    // 1 in the groove's middle, 0 at the waveform's edge.
    float depth = 1. - abs(side) / amp;
    bool peaking = powerAt(time) > 0.;
    vec3 colour;
    float bright;
    if (time <= u_time) {
      // Burning where it has played, brightest just behind the orb.
      float trail = exp(-(u_time - time) / 2.);
      colour = mix(peaking ? (side < 0. ? HOT_LOW : HOT_HIGH) : (side < 0. ? LOW : HIGH), WHITE, min(trail * 0.5, 0.7));
      bright = 0.6 + now.bass * 0.15 + trail * 0.4;
    } else {
      // Dim ahead, its peaks gold and pulsing as they near, lit a little way in front of the orb.
      float light = max(0., 1. - (time - u_time) / AHEAD);
      float pulse = peaking ? (0.2 + now.charge * (0.5 + 0.5 * sin(u_time * 14.))) : 0.;
      colour = mix(peaking ? DIM_PEAK : DIM, NEAR, light * 0.6);
      bright = 0.55 + light * 0.35 + pulse;
    }
    // Brightening as each throb passes; dancing, rings of colour running out from the orb.
    bright += blaze * 0.5 + hit * (0.15 + dancing * 0.5) + dancing * 0.2;
    if (dancing > 0.) {
      float hue = fract(length(p - orb) / 320. - u_time * 0.8) * 4.;
      vec3 running = hue < 1. ? mix(GOLD, HOT_LOW, hue) : hue < 2. ? mix(HOT_LOW, VIOLET, hue - 1.) : hue < 3. ? mix(VIOLET, HIGH, hue - 2.) : mix(HIGH, GOLD, hue - 3.);
      colour = mix(colour, running, dancing * 0.55);
    }
    // Stars, more as it is louder, most in its middle, twinkling.
    float star = random(at, 41), chance = depth * (0.25 + 0.75 * loud) * (1. + hit * (0.2 + dancing * 0.7));
    float twinkle = 0.75 + 0.25 * sin(u_time * (2. + random(at, 42) * 3.) + random(at, 43) * 6.3);
    if (star < chance)
      put(cell, star < chance * 0.15 ? STAR : star < chance * 0.4 ? PLUS : speck(0.), colour, bright * twinkle * (0.5 + 0.5 * depth));
  }

  // The minutes, just inside their loops.
  for (int minute = 1; minute < 10 && float(minute) * 60. < song; minute++) {
    vec2 anchor = pushed(pointOn(loopsAt(float(minute) * 60.), -spacing * 0.5));
    int column = at.x - int(floor(anchor.x / u_cell.x)) + 2;
    if (at.y == int(floor(anchor.y / u_cell.y)) && column >= 0 && column < 4)
      put(cell, column == 0 ? ZERO + minute : column == 1 ? COLON : ZERO, LABEL, float(minute) * 60. <= u_time ? 0.9 : 0.55);
  }

  // The orb.
  vec2 q = (p - orb) / radius;
  float r = length(q), angle = atan(q.y, q.x), from = length(p - orb);
  if (from < 360.) {
    // Mana shed as it goes, rising off it, more with the bass.
    float newest = floor(u_time * 20.);
    for (int i = 0; i < 24; i++) {
      float born = (newest - float(i)) / 20., old = u_time - born;
      if (born < 0.) break;
      int id = int(newest) - i;
      Music then = musicAt(born);
      if (random(id, 1, 23) > 0.3 + then.bass * 0.5 + then.flare * 0.5) continue;
      float heading = random(id, 2, 23) * 2. * PI, pace = 25. + random(id, 3, 23) * 60.;
      vec2 mote = pointOn(loopsAt(born), 0.) + vec2(cos(heading), sin(heading)) * (ORB * 0.9 + pace * old) + vec2(0, -30. * old * old);
      if (all(lessThanEqual(abs(mote - p), u_cell * 0.5)))
        put(cell, old < 0.35 ? STAR : old < 0.8 ? PLUS : speck(1.), mix(LILAC, VIOLET, old / 1.2), (1. - old / 1.2) * 0.9);
    }

    // Its aura, flickering off it.
    float reach = 0.5 + now.bass * 0.4 + now.flare * 0.4 + now.charge * 0.4 + blaze * 1.2;
    float flame = fbm(q / max(r, 0.001) * 1.7 + (r - u_time * 1.6) * 0.9 + 13.);
    float glow = r >= 1. ? (1. - (r - 1.) / reach) * (0.25 + flame) : 0.;
    if (glow > 0.35) put(cell, glow > 0.85 ? STAR : glow > 0.65 ? PLUS : glow > 0.48 ? COLON : speck(0.), mix(VIOLET, LILAC, glow), glow * 0.8);

    // The sphere, glowing from within: white-hot at its heart, veins of mana crackling over it as
    // it turns, and its rim aglow.
    if (r < 1.) {
      vec3 normal = vec3(q, sqrt(1. - r * r));
      float turning = u_time * 1.2 + now.spun.x * 0.3;
      float vein = 1. - abs(2. * fbm(vec2(atan(normal.x, normal.z) * 1.3 + turning, asin(normal.y) * 1.6 + turning * 0.3)) - 1.);
      float rim = pow(1. - normal.z, 4.);
      float amount = clamp(0.1 + pow(normal.z, 1.5) * 0.8 + pow(vein, 8.) * (0.25 + now.bass * 0.2 + blaze) + rim * 0.3, 0.05, 1.);
      vec3 colour = amount < 0.45 ? mix(NIGHT, VIOLET, amount / 0.45) : amount < 0.8 ? mix(VIOLET, LILAC, (amount - 0.45) / 0.35) : mix(LILAC, WHITE, (amount - 0.8) / 0.2);
      colour = mix(mix(colour, RIM, rim * 0.7), GOLD, min(blaze + now.overflow * 0.3, 0.6));
      const int GLOW[6] = int[6](DOT, COLON, PLUS, STAR, HASH, ATSIGN);
      put(cell, GLOW[clamp(int(amount * 6.), 0, 5)], colour, 0.7 + amount * 0.5);
    }

    // Every kick, a shell of mana bursting off it.
    float shell = age * RIPPLE;
    if (age < 0.45 && from > radius && abs(from - shell) <= tolerance(angle))
      put(cell, lineGlyph(angle + PI / 2.), mix(LILAC, RIM, age / 0.45), (1. - age / 0.45) * (0.4 + kick.strength * 0.6));

    // A spell's circle round it, its runes turning, flaring on the snares.
    float ring = radius * 1.45 + u_cell.y * 0.6;
    if (abs(from - ring) <= tolerance(angle))
      put(cell, rune((angle * ORB * 1.6 + u_time * 24. + now.spun.y * 20.) / u_cell.x), mix(VIOLET, LILAC, struck + blaze), 0.2 + now.mid * 0.25 + struck * 0.6 + blaze);

    // Before a peak, mana streaming into it from all round.
    const int RAYS = 40;
    int ray = int(floor((angle / (2. * PI) + 0.5) * float(RAYS)));
    for (int next = ray - 1; next <= ray + 1 && now.charge > 0.02; next++) {
      int line = (next + RAYS) % RAYS;
      float phase = fract(u_time * 0.8 + random(line, 17)), heading = (float(line) + random(line, 18)) / float(RAYS) * 2. * PI - PI;
      vec2 mote = orb + vec2(cos(heading), sin(heading)) * (radius + (1. - phase) * (1. - phase) * (120. + random(line, 19) * 140.));
      if (all(lessThanEqual(abs(mote - p), u_cell * 0.5))) put(cell, phase > 0.7 ? STAR : speck(1.), LILAC, now.charge * (0.4 + phase * 0.6));
    }

    // Sparks off it on the kicks.
    for (int i = 0; i < 8 && age < 0.6; i++) {
      float heading = random(kick.index, i, 5) * 2. * PI, pace = 80. + random(kick.index, i, 6) * 200.;
      vec2 spark = orb + vec2(cos(heading), sin(heading)) * (radius + pace * age * (1. - age * 0.6));
      if (all(lessThanEqual(abs(spark - p), u_cell * 0.5))) put(cell, age < 0.2 ? STAR : PLUS, mix(LILAC, GOLD, powerAt(u_time)), (1. - age / 0.6) * kick.strength);
    }
  }

  // A peak comes in with a shockwave from the orb.
  if (since < 1.5 && abs(from - radius - since * 700.) <= tolerance(angle))
    put(cell, lineGlyph(angle + PI / 2.), GOLD, bang * (1. - since / 1.5));
  return cell;
}
`,
};
