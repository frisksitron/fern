import { glyphSlot, rgb, type Effect } from '../shader';

/**
 * Tap tap: the song as a rhythm game, played perfectly. A note highway runs from far off, narrowing
 * almost to a point, down to the top of the player, where every note lands on its target on the
 * beat. The notes coming are the song still to come, so a chorus can be seen coming before it is
 * heard.
 *
 * - Bass: every kick is a bar across the highway, landing right across the strike line, and the
 *   crowd at the foot of the window jumps.
 * - Mid: snares are the big notes; the lasers sweep with the mids.
 * - Treble: hi-hats are the small ones.
 * - Calm stretches: long held notes, a phrase at a time, sparks fizzing off them as they are held;
 *   lighters in the crowd.
 * - Peaks: star power, for the first 10 seconds of each. The rails fill up in the seconds
 *   before; its notes come down as stars, and as it comes in a wave runs up the highway, the
 *   lasers blaze and hands go up.
 *
 * Every note is hit, and looks it: its target fills with light, a ring spreads from it, and
 * sparks fly.
 */
export const taptap: Effect = {
  id: 'taptap',
  name: 'Tap tap',
  background: '#0c0a1c',
  dark: true,
  flash: '#f0d9ff',
  texts: () => ['SCORE', 'STREAK', 'PERFECT'],
  shader: /* glsl */ `
const vec3 LANE_COLOURS[6] = vec3[6](
  ${rgb('#ff3d8b')}, ${rgb('#ffb000')}, ${rgb('#2ee6d6')}, ${rgb('#8b5cff')}, ${rgb('#7dff5c')}, ${rgb('#ff6a2e')}
);
const vec3 RAIL = ${rgb('#6b5cff')};
const vec3 DIVIDER = ${rgb('#2c2658')};
const vec3 KICKED = ${rgb('#ff7a1f')};
const vec3 STARRY = ${rgb('#8ff3ff')};
const vec3 WHITE = ${rgb('#ffffff')};
const vec3 SHADOW = ${rgb('#2e2850')};
const vec3 LIT = ${rgb('#9d93e8')};
const vec3 FLAME = ${rgb('#ffcf5c')};
const vec3 LABEL = ${rgb('#8f86d9')};
const int O = ${glyphSlot('o')}, X = ${glyphSlot('x')}, ZERO = ${glyphSlot('0')};
const int OPEN = ${glyphSlot('(')}, CLOSE = ${glyphSlot(')')};
/** Lanes down the highway; how deep it is (see \`depthAt\`), and how wide against the player. */
const int LANES = 4;
const float DEPTH = 12., WIDTH = 0.85;
/** Seconds of notes on the highway; of each peak with star power. */
const float AHEAD = 2., STAR_POWER = 10.;
/** Seconds a held note lasts, the gap after it included; how deep a note is. */
const float PHRASE = 2.4, GEM = 0.14;

/**
 * The highway, in perspective: where it would vanish, where it ends (screen rows), its middle, and
 * its width there. How deep a point on it is counts in the distance from the eye to its end.
 */
float vanish, strike, middle, span, speed;

/** The screen row of the highway \`z\` deep (0 at the end), and back. */
float rowAt(float z) { return vanish + (strike - vanish) / (1. + z); }
float depthAt(float y) { return (strike - vanish) / max(y - vanish, 0.01) - 1.; }
/** Half the highway's width \`z\` deep. */
float halfWidth(float z) { return span / 2. / (1. + z); }
/** Where the middle of a lane is across the screen, \`z\` deep. */
float laneX(int lane, float z) { return middle + ((float(lane) + 0.5) / float(LANES) * 2. - 1.) * halfWidth(z); }
/** The lane a snare or hi-hat comes down. */
int laneOf(int kind, Event note) { return int(random(note.index, kind, 3) * float(LANES)); }
/** The lane of the held note starting phrase number \`phrase\` (see PHRASE), or -1: they come only in calm stretches. */
int heldLane(float phrase) {
  return musicAt(phrase * PHRASE + 0.1).calm > 0.5 ? int(random(int(phrase), 5) * float(LANES)) : -1;
}
/** Whether there is star power at \`time\`: the first STAR_POWER seconds of a peak (a peak can last minutes). */
bool starAt(float time) {
  Event peak = latest(PEAK, time);
  return time < peak.end && time - peak.start < STAR_POWER;
}
/** The colour of a kick's bar, and of it landing. */
vec3 kickColour(Event kick) { return starAt(kick.start) ? STARRY : KICKED; }

/** A note's half-width and half-height on screen \`z\` deep: \`size\` of its lane wide, GEM deep. */
vec2 noteSize(float z, float size) {
  return vec2(halfWidth(z) / float(LANES) * size, (rowAt(z - GEM / 2.) - rowAt(z + GEM / 2.)) / 2.) + u_cell * 0.5;
}

/** Where the cell at p is on the note due at \`due\` down a lane, from -1 to 1 across and down it; or (0, 2) if off it. */
vec2 onNote(vec2 p, int lane, float due, float size) {
  float z = (due - u_time) * speed;
  vec2 on = (p - vec2(laneX(lane, z), rowAt(z))) / noteSize(z, size);
  return length(on) <= 1. ? on : vec2(0, 2);
}

/** Shows a note \`size\` of its lane wide in the cell, \`on\` it: bracketed, bright in the middle, a star if in a peak. */
void gem(inout Cell cell, vec2 on, int lane, float due, float strength, float size) {
  float z = (due - u_time) * speed, wide = noteSize(z, size).x;
  bool star = starAt(due);
  int glyph = star ? STAR : abs(on.x) < 0.3 ? ATSIGN : HASH;
  if (wide >= u_cell.x * 1.5 && abs(on.x) > 1. - u_cell.x / wide && abs(on.y) < 0.7) glyph = on.x < 0. ? OPEN : CLOSE;
  vec3 colour = star ? STARRY : LANE_COLOURS[lane];
  put(cell, glyph, mix(colour, WHITE, (1. - length(on)) * 0.4), (1. - smoothstep(DEPTH * 0.6, DEPTH, z)) * (0.7 + strength * 0.3));
}

/** The snares or hi-hats (\`kind\`) due down a lane between depths z1 and z2, \`size\` of it wide. */
void notes(inout Cell cell, vec2 p, int lane, int kind, float z1, float z2, float size) {
  Event note = latest(kind, u_time + (z2 + GEM) / speed);
  for (int i = 0; i < 3 && note.start >= max(u_time, u_time + (z1 - GEM) / speed); i++) {
    vec2 on = onNote(p, lane, note.start, size);
    if (laneOf(kind, note) == lane && on.y < 2.) {
      gem(cell, on, lane, note.start, note.strength, size);
      return;
    }
    note = before(kind, note);
  }
}

/** Whether the cell at p is on the outline of an oval, and which way it faces there (\`bend\`). */
bool onOval(vec2 p, vec2 centre, vec2 radius, out float bend) {
  vec2 q = (p - centre) / radius, normal = q / radius;
  float r = max(length(q), 0.001);
  bend = atan(normal.y, normal.x);
  return abs((r - 1.) / length(normal / r)) <= tolerance(bend);
}

/** How long ago the latest note landed on a lane's target, if one did in the last \`within\` seconds; or -1. */
float landed(int lane, int kind, float within) {
  Event note = latest(kind, u_time);
  for (int i = 0; i < 3 && u_time - note.start < within; i++) {
    if (laneOf(kind, note) == lane) return u_time - note.start;
    note = before(kind, note);
  }
  return -1.;
}

/** Sparks flung up off a lane's target \`age\` seconds ago, \`count\` of them (\`seed\` picks their ways). */
void sparks(inout Cell cell, vec2 p, int lane, float age, int count, int seed, vec3 colour) {
  if (age < 0. || age >= 0.7) return;
  vec2 from = vec2(laneX(lane, 0.), strike);
  for (int s = 0; s < count; s++) {
    float angle = -PI / 2. + (random(seed, s, lane) - 0.5) * 2.4, pace = 150. + random(seed, s, lane + 9) * 350.;
    vec2 spark = from + vec2(cos(angle), sin(angle)) * pace * age + vec2(0, 600. * age * age);
    if (all(lessThanEqual(abs(spark - p), u_cell * 0.5)))
      put(cell, age < 0.2 ? STAR : age < 0.45 ? PLUS : DOT, mix(WHITE, colour, min(1., age * 2.)), 1. - age / 0.7);
  }
}

/** The glyph \`column\` along the number n written \`digits\` wide; SPACE outside it. */
int digitGlyph(int n, int digits, int column) {
  if (column < 0 || column >= digits) return SPACE;
  for (int i = 0; i < digits - 1 - column; i++) n /= 10;
  return ZERO + n % 10;
}

/** The glyph \`column\` along a line of text; SPACE outside it. */
int textAt(int text, int column) {
  return column < 0 || column >= textLength(text) ? SPACE : textGlyph(text, float(column));
}

/** The word for how well a note was hit, rising off its lane's target \`age\` seconds after. */
void judge(inout Cell cell, ivec2 at, int lane, float age, vec3 colour) {
  if (age < 0. || age >= 0.5) return;
  int row = int(floor((strike - u_cell.y * 2.5 - age * 60.) / u_cell.y));
  if (at.y == row) put(cell, textAt(2, at.x - int(laneX(lane, 0.) / u_cell.x) + textLength(2) / 2), colour, 1. - age / 0.5);
}

Cell draw(vec2 p, ivec2 at) {
  Cell cell = NOTHING;
  Music now = musicAt(u_time);
  // The highway runs from the top of the window, DEPTH deep, to its targets just above the player,
  // three rows high, the middle one the strike line.
  int strikeRow = int(floor(u_player.y / u_cell.y - 0.5)) - 1;
  strike = (float(strikeRow) + 0.5) * u_cell.y;
  float top = u_cell.y * 3.;
  vanish = (top * (1. + DEPTH) - strike) / DEPTH;
  middle = (u_player.x + u_player.z) / 2.;
  span = (u_player.z - u_player.x) * WIDTH;
  speed = DEPTH / AHEAD;
  Event peak = latest(PEAK, u_time);
  float since = u_time - peak.start, bang = 0.6 + peak.strength * 0.4;
  float blaze = since < 3. ? bang * exp(-since / 0.6) : 0.;
  bool starred = starAt(u_time);
  Event kick = latest(KICK, u_time);
  float kicked = u_time - kick.start;

  // Where p is on the highway, and whether it is on it at all (down into its targets).
  float z = depthAt(p.y), u = (p.x - middle) / halfWidth(z), end = strike - u_cell.y * 0.5;
  bool onHighway = p.y >= top - u_cell.y / 2. && p.y < end && abs(u) <= 1.;

  // Lasers from behind the crowd, sweeping with the mids, flashing on the kicks, blazing in a
  // peak; not over the highway or its targets.
  float beam = ((0.12 + now.bass * 0.2 + now.flare * 0.4) * (1. - now.calm * 0.8) + now.overflow * 0.4 + blaze);
  bool clear = p.y < top - u_cell.y || p.y > strike + u_cell.y * 1.5 || abs(u) > 1.2;
  for (int i = 0; i < 6 && clear && beam > 0.03; i++) {
    vec2 from = vec2(u_view.x * (float(i) + 0.5) / 6., u_view.y - u_cell.y * 5.5);
    float aim = -PI / 2. + sin(now.spun.y * 0.3 + float(i) * 2.1) * 0.6;
    if (onLine(p, from, aim)) put(cell, lineGlyph(aim), LANE_COLOURS[i], beam * exp(-length(p - from) / 900.));
  }

  // The crowd at the foot of the window, two rows deep: jumping on the kicks, hands up through a
  // peak, lighters up when calm.
  int up = u_grid.y - 1 - at.y;
  for (int back = 1; back >= 0 && up < 7; back--) {
    int column = at.x + back * 2, person = column / 4, place = column % 4, seed = person * 2 + back;
    if (random(seed, 70) < 0.2) continue;
    bool jumping = kicked < 0.2 && random(seed, kick.index, 71) < (0.2 + now.overflow * 0.6) * kick.strength * (1. - now.calm);
    int row = up - back * 2 - (jumping ? 1 : 0);
    bool cheering = random(seed, peak.index, 72) < now.overflow * (starred ? 1.3 : 0.25) + blaze;
    bool lighter = !cheering && random(seed, 73) < (now.calm - 0.3) * 0.7;
    int glyph = SPACE;
    if (place == 3 || row < 0 || row > 2) glyph = SPACE;
    else if (row == 0) glyph = place == 1 ? BAR : cheering || (lighter && place == 2) ? SPACE : place == 0 ? SLASH : BACKSLASH;
    else if (row == 1) glyph = place == 1 ? O : cheering ? (place == 0 ? BACKSLASH : SLASH) : lighter && place == 2 ? SLASH : SPACE;
    else if (lighter && place == 2) glyph = fract(u_time * 2.3 + random(seed, 74)) < 0.5 ? STAR : PLUS;
    vec3 colour = row == 2 ? FLAME : mix(SHADOW, starred ? STARRY : LIT, min(1., now.bass * 0.35 + now.flare * 0.4 + now.overflow * 0.3 + blaze) * (1. - float(back) * 0.4));
    put(cell, glyph, colour, row == 2 ? 0.9 : 1. - float(back) * 0.35);
  }

  // The score beside the player: points, and the streak of notes hit (every one of them).
  int streak = kick.index + latest(SNARE, u_time).index + latest(HAT, u_time).index;
  int middleRow = int((u_player.y + u_player.w) / 2. / u_cell.y);
  if (u_player.x > u_cell.x * 12. && at.y >= middleRow - 1 && at.y <= middleRow + 1) {
    int left = int(u_player.x / 2. / u_cell.x), right = int((u_player.z + u_view.x) / 2. / u_cell.x);
    int points = 50 * (streak + max(streak - 10, 0) + max(streak - 20, 0) + max(streak - 30, 0));
    int times = (starred ? 2 : 1) * min(4, 1 + streak / 10);
    int row = at.y - middleRow, glyph = SPACE;
    if (row == -1) glyph = at.x < u_grid.x / 2 ? textAt(0, at.x - left + 2) : textAt(1, at.x - right + 3);
    if (row == 0) glyph = at.x < u_grid.x / 2 ? digitGlyph(points, 7, at.x - left + 3) : digitGlyph(streak, 4, at.x - right + 2);
    if (row == 1 && at.x >= u_grid.x / 2) glyph = at.x == right ? X : at.x == right + 1 ? ZERO + times : SPACE;
    put(cell, glyph, row == 0 ? WHITE : starred && row == 1 ? STARRY : LABEL, row == 0 ? 0.9 : 0.75);
  }

  // The highway.
  if (onHighway) {
    cell = NOTHING;
    int lane = clamp(int((u + 1.) / 2. * float(LANES)), 0, LANES - 1);
    float z1 = depthAt(p.y + u_cell.y / 2.), z2 = depthAt(p.y - u_cell.y / 2.), due = u_time + z / speed;
    float fade = 1. - smoothstep(DEPTH * 0.6, DEPTH, z);
    // Between the lanes, dashes flowing down it (a line far off, where they would crowd together).
    float across = (u + 1.) / 2. * float(LANES), divider = round(across), off = divider - float(LANES) / 2.;
    float run = off * span / float(LANES) / (strike - vanish);
    if (abs(off) < float(LANES) / 2. - 0.5 && abs(across - divider) * 2. * halfWidth(z) / float(LANES) <= 0.5 * (u_cell.x + abs(run) * u_cell.y)
      && (z > 2. || fract(z * 3. + u_time * speed * 3.) < 0.6))
      put(cell, lineGlyph(atan(1., run)), starred ? STARRY : DIVIDER, fade * (starred ? 0.5 : 0.8));
    // Calm stretches are held notes, a phrase at a time, each down a lane of its own.
    float stretch = floor(due / PHRASE);
    int holding = heldLane(stretch);
    Music then = musicAt(due);
    run = (laneX(max(holding, 0), 0.) - middle) / (strike - vanish);
    if (lane == holding && due - stretch * PHRASE < PHRASE - 0.5 && then.calm > 0.5 && then.mid + then.bass > 0.1
      && abs(p.x - laneX(holding, z)) <= 0.5 * (u_cell.x + abs(run) * u_cell.y))
      put(cell, lineGlyph(atan(1., run)), LANE_COLOURS[holding], fade * (0.35 + then.mid * 0.65));
    // Its head.
    stretch = floor(due / PHRASE + 0.5);
    holding = heldLane(stretch);
    vec2 on = onNote(p, max(holding, 0), stretch * PHRASE, 0.8);
    if (stretch * PHRASE >= u_time && lane == holding && on.y < 2.) gem(cell, on, holding, stretch * PHRASE, 0.6, 0.8);
    // Kicks: a bar right across it.
    Event bar = latest(KICK, u_time + z2 / speed);
    if (bar.start >= max(u_time, u_time + z1 / speed)) put(cell, EQUALS, kickColour(bar), fade * (0.5 + bar.strength * 0.5));
    // Snares and hi-hats: notes down the lanes.
    notes(cell, p, lane, SNARE, z1, z2, 0.8);
    notes(cell, p, lane, HAT, z1, z2, 0.35);
    // A peak comes in with a wave running up the highway.
    float wave = since * DEPTH * 1.5;
    if (since < 1. && z1 <= wave && z2 >= wave) put(cell, HASH, mix(WHITE, STARRY, since), bang * (1. - since));
  }

  // Its rails, filling up with light in the seconds before a peak.
  for (int side = -1; side <= 1; side += 2) {
    float angle = atan(strike - vanish, float(side) * span / 2.);
    if (p.y >= top - u_cell.y / 2. && p.y < end && onLine(p, vec2(middle, vanish), angle)) {
      bool charged = p.y >= strike - (strike - top) * now.charge;
      put(cell, lineGlyph(angle), starred || charged ? STARRY : RAIL,
        (0.5 + now.bass * 0.3 + now.flare * 0.4 + (starred || charged ? 0.4 : 0.)) * (1. - smoothstep(DEPTH * 0.6, DEPTH, z)));
    }
  }

  // The targets at the end of the highway, an oval to a lane, flashing as a kick's bar lands.
  int lane = clamp(int(((p.x - middle) / (span / 2.) + 1.) / 2. * float(LANES)), 0, LANES - 1);
  vec2 centre = vec2(laneX(lane, 0.), strike), radius = vec2(span / 2. / float(LANES) * 0.85, u_cell.y * 1.1);
  float r = length((p - centre) / radius), bend;
  bool kicking = kicked < 0.15;
  if (onOval(p, centre, radius, bend)) {
    int glyph = lineGlyph(bend + PI / 2.);
    put(cell, glyph == BAR ? (p.x < centre.x ? OPEN : CLOSE) : glyph, kicking ? mix(WHITE, kickColour(kick), kicked / 0.15) : LANE_COLOURS[lane], kicking ? 1. : 0.45 + now.bass * 0.2);
  }
  // A kick's bar lands right across the strike line.
  if (kicking && at.y == strikeRow && abs(p.x - middle) <= span / 2.) put(cell, EQUALS, mix(WHITE, kickColour(kick), kicked / 0.15), 1.2 - kicked * 4.);
  // The held note now, if there is one: its lane, and how long since its head landed. Its target
  // stays lit while it is held.
  float phrase = floor(u_time / PHRASE), holdAge = u_time - phrase * PHRASE;
  int holdLane = heldLane(phrase);
  bool holding = holdLane >= 0 && holdAge < PHRASE - 0.5 && now.calm > 0.5 && now.mid + now.bass > 0.1;
  if (holding && lane == holdLane && r < 1.) put(cell, r < 0.5 ? COLON : DOT, LANE_COLOURS[lane], 0.5 + now.mid * 0.5);
  // Every note that lands is hit, and looks it: its target flashes full of light and a ring
  // spreads from it. Snares and hi-hats land on their own lane's target, a held note's head on
  // its lane's.
  vec3 struck = starred ? STARRY : LANE_COLOURS[lane];
  float lately = 1e6, age = landed(lane, SNARE, 0.5);
  if (age >= 0.) lately = age;
  age = landed(lane, HAT, 0.5);
  if (age >= 0. && age < lately) lately = age;
  if (lane == holdLane && holdAge < lately) lately = holdAge;
  if (lately < 0.2 && r < 1.) {
    int glyph = lately < 0.07 ? (r < 0.5 ? ATSIGN : HASH) : lately < 0.14 ? (r < 0.5 ? HASH : PLUS) : r < 0.5 ? PLUS : COLON;
    put(cell, glyph, mix(WHITE, struck, min(1., lately / 0.12)), 1.);
  }
  if (lately < 0.4 && onOval(p, centre, radius * (1. + lately * 3.), bend)) put(cell, lineGlyph(bend + PI / 2.), struck, 1. - lately / 0.4);

  // Sparks flying up off the notes landing, and the word for how well they were hit.
  if (abs(p.y - strike) < 260.) {
    for (int k = 0; k < 2; k++) {
      int kind = k == 0 ? SNARE : HAT;
      Event note = latest(kind, u_time);
      for (int i = 0; i < 2; i++) {
        int landing = laneOf(kind, note);
        vec3 colour = starred ? STARRY : LANE_COLOURS[landing];
        sparks(cell, p, landing, u_time - note.start, kind == SNARE ? 14 : 9, note.index * 8 + kind, colour);
        if (kind == SNARE) judge(cell, at, landing, u_time - note.start, colour);
        note = before(kind, note);
      }
    }
    // A kick's bar breaks into sparks along the strike line.
    for (int each = 0; each < LANES; each++) sparks(cell, p, each, kicked, 3, kick.index * 8 + KICK, kickColour(kick));
    // A held note's head lands like any note, and sparks fizz off its target while it is held.
    if (holdLane >= 0) {
      sparks(cell, p, holdLane, holdAge, 12, int(phrase) * 8 + 7, LANE_COLOURS[holdLane]);
      judge(cell, at, holdLane, holdAge, LANE_COLOURS[holdLane]);
    }
    for (int s = 0; s < 6 && holding; s++) {
      float stream = u_time / 0.35 + random(s, 80), cycle = floor(stream);
      sparks(cell, p, holdLane, (stream - cycle) * 0.35, 2, int(cycle) * 8 + s, LANE_COLOURS[holdLane]);
    }
  }
  return cell;
}
`,
};
