/**
 * Finds songs in the library from a title, artist, and album written by a person or an agent, such
 * as "Hey Jude — The Beatles". Tags are often missing or spelled differently, so matching ignores
 * case, accents, and punctuation, sets aside qualifiers such as "(Remastered 2011)" or "feat. X", and
 * falls back to the file name and folders when a song has no tags.
 */

/** The song fields matching reads. `folders` are the song's folder names, root first. */
export type MatchableTrack = {
  readonly id: string;
  readonly name: string;
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly albumArtist: string | null;
  readonly folders: readonly string[];
};

export type TrackQuery = { readonly title: string; readonly artist?: string; readonly album?: string };

/**
 * - `exact`: the title (and the artist and album, when given) agree, apart from qualifiers such as a remaster.
 * - `likely`: close enough to use, but spelled differently or a different release.
 * - `ambiguous`: a candidate exists but should be confirmed: another version, another artist, or a close tie.
 * - `none`: nothing in the library resembles the song.
 */
export type MatchConfidence = 'exact' | 'likely' | 'ambiguous' | 'none';

export type TrackMatch<Track> = {
  readonly confidence: MatchConfidence;
  /** The best candidate, unless the confidence is `none`. */
  readonly match: Track | null;
  /** Other candidates, best first, for the caller to choose from when the match is uncertain. */
  readonly alternatives: readonly Track[];
};

const LIKELY_SCORE = 0.8;
const AMBIGUOUS_SCORE = 0.55;
/** A different song scoring within this much of the best makes the best one uncertain. */
const TIE_MARGIN = 0.05;
const ALTERNATIVES = 3;

/** Lowercase letters and digits separated by single spaces: no accents, punctuation, or apostrophes. */
export function normalizeText(text: string) {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Qualifiers that name a different recording or arrangement of a song. */
const VERSION_WORDS = [
  'live',
  'remix',
  'mix',
  'demo',
  'acoustic',
  'instrumental',
  'karaoke',
  'unplugged',
  'orchestral',
  'cover',
  'reprise',
  'rehearsal',
];
/** Qualifiers that leave the recording the same, or only name who is on it. */
const RELEASE_WORDS = [
  'feat',
  'ft',
  'featuring',
  'with',
  'remaster',
  'remastered',
  'mono',
  'stereo',
  'version',
  'edit',
  'explicit',
  'clean',
  'single',
  'radio',
  'album',
  'original',
  'bonus',
  'deluxe',
  'edition',
  'expanded',
  'anniversary',
];
const QUALIFIER = new RegExp(`\\b(${[...VERSION_WORDS, ...RELEASE_WORDS].join('|')}|\\d{4})\\b`);

function isQualifier(text: string) {
  return QUALIFIER.test(normalizeText(text));
}

/**
 * Splits a title into the song's name and its qualifiers: bracketed or dash-separated parts that
 * mention a version, remaster, featured artist, or year. Other brackets, such as in
 * "(I Can't Get No) Satisfaction", stay part of the name.
 */
export function splitTitle(title: string) {
  const qualifiers: string[] = [];
  let core = title.replace(/\s*[([]([^)\]]*)[)\]]/g, (whole, inner: string) => {
    if (!isQualifier(inner)) return whole;
    qualifiers.push(inner);
    return ' ';
  });
  core = core.replace(/\s+[-–—]\s+([^-–—]+)$/, (whole, suffix: string) => {
    if (!isQualifier(suffix)) return whole;
    qualifiers.push(suffix);
    return '';
  });
  core = core.replace(/\s+(feat\.?|ft\.|featuring)\s.*$/i, (whole) => {
    qualifiers.push(whole);
    return '';
  });
  const versions = new Set(
    qualifiers
      .flatMap((qualifier) => normalizeText(qualifier).split(' '))
      .filter((word) => VERSION_WORDS.includes(word)),
  );
  return { core: normalizeText(core) || normalizeText(title), full: normalizeText(title), versions };
}

/**
 * A leading track number, with an optional disc number: "03 - ", "12. ", "1-03 ", or "07 ". A
 * number is only taken for a track number when a separator follows it or it is zero-padded, so
 * "50 Ways to Leave Your Lover" and "1999" keep their numbers.
 */
const TRACK_NUMBER = /^\s*(?:\d{1,2}[-.])?(?:\d{1,3}\s*[-._)]\s*|0\d{1,2}\s+)/;

/** A song's name from its file name, without the extension or a leading track number. */
export function fileTitle(name: string) {
  const base = name.replace(/\.[^.]+$/, '').trim();
  return base.replace(TRACK_NUMBER, '').trim() || base;
}

function bigrams(text: string) {
  const padded = ` ${text} `;
  const result = new Map<string, number>();
  for (let index = 0; index < padded.length - 1; index++) {
    const pair = padded.slice(index, index + 2);
    result.set(pair, (result.get(pair) ?? 0) + 1);
  }
  return result;
}

/** How alike two normalized strings are, from 0 to 1, by shared letter pairs (Sørensen–Dice). */
export function similarity(left: string, right: string) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const a = bigrams(left);
  const b = bigrams(right);
  let shared = 0;
  let total = 0;
  for (const [pair, count] of a) {
    shared += Math.min(count, b.get(pair) ?? 0);
    total += count;
  }
  for (const count of b.values()) total += count;
  return (2 * shared) / total;
}

function containsWords(haystack: string, needle: string) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

/** An artist name for comparison: normalized, without a leading "The" (or a trailing ", The"). */
export function normalizeArtist(artist: string) {
  return normalizeText(artist.replace(/,\s*the\s*$/i, '')).replace(/^the /, '');
}

/** The individual artists in a credit such as "Jay-Z & Kanye West feat. Frank Ocean". */
function artistParts(artist: string) {
  return artist
    .split(/\s*(?:[,;/&+×]|\s(?:and|x|vs\.?|feat\.?|ft\.|featuring|with)\s)\s*/i)
    .map(normalizeArtist)
    .filter(Boolean);
}

type PreparedTitle = ReturnType<typeof splitTitle>;

function isVersionAlbum(album: string) {
  return normalizeText(album)
    .split(' ')
    .some((word) => VERSION_WORDS.includes(word));
}

type PreparedTrack<Track> = {
  readonly track: Track;
  readonly titles: readonly PreparedTitle[];
  /** Each credited artist and album artist, whole and split into parts. */
  readonly artists: readonly string[];
  /** Normalized folder names, used for the artist and album when tags are missing. */
  readonly folders: readonly string[];
  readonly album: PreparedTitle | null;
  /** Identifies the song regardless of release: the same title by the same artist. */
  readonly identity: string;
  /** The album is a live, remix, or similar release, which ties with the original go against. */
  readonly versionRelease: boolean;
};

function prepareTrack<Track extends MatchableTrack>(track: Track): PreparedTrack<Track> {
  const fromFile = fileTitle(track.name);
  // An untagged song may be "Title", "Artist - Title", or start with a number that belongs to the
  // title after all ("12 Monkeys"), so each reading is a candidate and the best one scores.
  const names = track.title
    ? [track.title]
    : [
        ...new Set([
          fromFile,
          ...(fromFile.includes(' - ') ? [fromFile.split(' - ').at(-1)!] : []),
          track.name.replace(/\.[^.]+$/, '').trim(),
        ]),
      ];
  const titles = names.map(splitTitle);
  const credits = [track.artist, track.albumArtist].filter((credit): credit is string => Boolean(credit));
  const artists = [...new Set(credits.flatMap((credit) => [normalizeArtist(credit), ...artistParts(credit)]))];
  return {
    track,
    titles,
    artists,
    folders: track.folders.map(normalizeText),
    album: track.album ? splitTitle(track.album) : null,
    identity: `${titles[0]?.core ?? ''}\u0000${artistParts(credits[0] ?? '')[0] ?? ''}`,
    versionRelease: track.album ? splitTitle(track.album).versions.size > 0 || isVersionAlbum(track.album) : false,
  };
}

function titleScore(query: PreparedTitle, candidate: PreparedTitle) {
  if (query.full === candidate.full) return 1;
  if (query.core === candidate.core) {
    const sameVersion =
      query.versions.size === candidate.versions.size &&
      [...query.versions].every((word) => candidate.versions.has(word));
    return sameVersion ? 0.95 : 0.75;
  }
  return 0.9 * similarity(query.core, candidate.core);
}

function artistScore(query: string, track: PreparedTrack<unknown>) {
  const wanted = [normalizeArtist(query), ...artistParts(query)];
  if (!track.artists.length) {
    return track.folders.some((folder) => wanted.some((artist) => folder === artist || containsWords(folder, artist)))
      ? 0.9
      : 0;
  }
  let best = 0;
  for (const artist of wanted) {
    for (const credited of track.artists) {
      if (artist === credited) return 1;
      if (containsWords(credited, artist) || containsWords(artist, credited)) best = Math.max(best, 0.9);
      else best = Math.max(best, 0.85 * similarity(artist, credited));
    }
  }
  return best;
}

function albumScore(query: PreparedTitle, track: PreparedTrack<unknown>) {
  if (track.album) return titleScore(query, track.album);
  return track.folders.some((folder) => folder === query.core || folder === query.full) ? 0.9 : 0;
}

type Scores = { total: number; title: number; artist: number | null; album: number | null };

function score(query: PreparedQuery, track: PreparedTrack<unknown>): Scores {
  const title = Math.max(...track.titles.map((candidate) => titleScore(query.title, candidate)));
  const artist = query.artist === undefined ? null : artistScore(query.artist, track);
  const album = query.album === null ? null : albumScore(query.album, track);
  // Weights: the title decides, the artist separates songs that share a title, the album a release.
  let weighted = 0.65 * title;
  let weights = 0.65;
  if (artist !== null) {
    weighted += 0.25 * artist;
    weights += 0.25;
  }
  if (album !== null) {
    weighted += 0.1 * album;
    weights += 0.1;
  }
  return { total: weighted / weights, title, artist, album };
}

type PreparedQuery = { title: PreparedTitle; artist: string | undefined; album: PreparedTitle | null };

function confidenceOf(
  best: Scores,
  bestIdentity: string,
  others: readonly { scores: Scores; identity: string }[],
): MatchConfidence {
  // Another song (not another release of this one) scoring about as well, such as the same title
  // by a different artist when no artist was given.
  const tied = others.some((other) => other.identity !== bestIdentity && other.scores.total >= best.total - TIE_MARGIN);
  if (!tied) {
    const artistAgrees = best.artist === null || best.artist >= 0.9;
    if (best.title >= 0.95 && artistAgrees && (best.album === null || best.album >= 0.9)) return 'exact';
    // A title scoring under 0.8 is another version of the song (0.75) or spelled quite differently.
    if (best.total >= LIKELY_SCORE && best.title >= 0.8 && (best.artist === null || best.artist >= 0.75)) {
      return 'likely';
    }
  }
  return best.total >= AMBIGUOUS_SCORE ? 'ambiguous' : 'none';
}

/** Words too common to find candidates by, unless a title has nothing else. */
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'my', 'me', 'you', 'i', 'is', 'it']);

function searchWords(text: string) {
  const words = text.split(' ').filter(Boolean);
  const distinctive = words.filter((word) => !STOP_WORDS.has(word));
  return distinctive.length ? distinctive : words;
}

/**
 * The library's songs, prepared once for matching many queries. Candidates come from an index of
 * title and artist words, so a query compares against the songs that share a word with it rather
 * than the whole library.
 */
export class TrackMatcher<Track extends MatchableTrack> {
  readonly #tracks: PreparedTrack<Track>[];
  readonly #byTitleWord = new Map<string, number[]>();
  readonly #byArtistWord = new Map<string, number[]>();

  constructor(tracks: readonly Track[]) {
    this.#tracks = tracks.map(prepareTrack);
    for (const [index, track] of this.#tracks.entries()) {
      for (const word of new Set(track.titles.flatMap((title) => title.core.split(' ')))) {
        TrackMatcher.#add(this.#byTitleWord, word, index);
      }
      const artistWords = track.artists.length ? track.artists : track.folders;
      for (const word of new Set(artistWords.flatMap((artist) => artist.split(' ')))) {
        TrackMatcher.#add(this.#byArtistWord, word, index);
      }
    }
  }

  static #add(index: Map<string, number[]>, word: string, track: number) {
    if (!word) return;
    const tracks = index.get(word);
    if (tracks) tracks.push(track);
    else index.set(word, [track]);
  }

  /**
   * Songs whose title has every word of the requested title; when none do (a word is misspelled or
   * missing), songs sharing any word with it; when none share a word, the artist's songs.
   */
  #candidates(query: PreparedQuery) {
    const titleLists = searchWords(query.title.core).map((word) => this.#byTitleWord.get(word) ?? []);
    let found = TrackMatcher.#intersection(titleLists);
    if (!found.size) found = new Set(titleLists.flat());
    if (!found.size && query.artist) {
      found = new Set(searchWords(normalizeArtist(query.artist)).flatMap((word) => this.#byArtistWord.get(word) ?? []));
    }
    return [...found].map((index) => this.#tracks[index]!);
  }

  static #intersection(lists: readonly number[][]) {
    if (!lists.length || lists.some((list) => !list.length)) return new Set<number>();
    const [shortest, ...rest] = [...lists].sort((left, right) => left.length - right.length);
    const others = rest.map((list) => new Set(list));
    return new Set(shortest!.filter((index) => others.every((other) => other.has(index))));
  }

  /** The library's best match for one song, how sure it is, and a few alternatives. */
  match(query: TrackQuery): TrackMatch<Track> {
    const prepared: PreparedQuery = {
      title: splitTitle(query.title),
      artist: query.artist?.trim() || undefined,
      album: query.album?.trim() ? splitTitle(query.album) : null,
    };
    const ranked = this.#candidates(prepared)
      .map((track) => ({ track, scores: score(prepared, track), identity: track.identity }))
      .filter(({ scores }) => scores.total > 0.4)
      .sort(
        (left, right) =>
          right.scores.total - left.scores.total ||
          Number(left.track.versionRelease) - Number(right.track.versionRelease) ||
          Number(Boolean(right.track.track.title)) - Number(Boolean(left.track.track.title)) ||
          left.track.track.name.localeCompare(right.track.track.name),
      );
    const [best, ...others] = ranked;
    if (!best) return { confidence: 'none', match: null, alternatives: [] };
    const confidence = confidenceOf(best.scores, best.identity, others);
    const alternatives = others.slice(0, ALTERNATIVES).map(({ track }) => track.track);
    if (confidence === 'none')
      return { confidence, match: null, alternatives: [best.track.track, ...alternatives].slice(0, ALTERNATIVES) };
    return { confidence, match: best.track.track, alternatives };
  }
}
