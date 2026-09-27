import { describe, expect, it } from 'vitest';
import { fileTitle, normalizeText, splitTitle, TrackMatcher, type MatchableTrack } from '../../src/lib/music/matching';

let nextId = 0;

function track(fields: Partial<MatchableTrack> & { name?: string }): MatchableTrack {
  nextId++;
  return {
    id: `track-${nextId}`,
    name: fields.name ?? `${fields.title ?? 'Untitled'}.flac`,
    title: fields.title ?? null,
    artist: fields.artist ?? null,
    album: fields.album ?? null,
    albumArtist: fields.albumArtist ?? null,
    folders: fields.folders ?? ['Music'],
  };
}

const heyJude = track({ title: 'Hey Jude - Remastered 2015', artist: 'The Beatles', album: '1' });
const letItBe = track({ title: 'Let It Be', artist: 'The Beatles', album: 'Let It Be' });
const letItBeLive = track({ title: 'Let It Be (Live)', artist: 'The Beatles', album: 'Live at the BBC' });
const hurtNin = track({ title: 'Hurt', artist: 'Nine Inch Nails', album: 'The Downward Spiral' });
const hurtCash = track({ title: 'Hurt', artist: 'Johnny Cash', album: 'American IV' });
const joga = track({ title: 'Jóga', artist: 'Björk', album: 'Homogenic' });
const satisfaction = track({ title: "(I Can't Get No) Satisfaction", artist: 'The Rolling Stones' });
const featured = track({ title: 'Empire State of Mind (feat. Alicia Keys)', artist: 'Jay-Z & Alicia Keys' });
const untagged = track({ name: '03 - Teardrop.mp3', folders: ['Music', 'Massive Attack', 'Mezzanine'] });
const sameSongOnCompilation = track({
  title: 'Let It Be',
  artist: 'The Beatles',
  album: 'Greatest Hits',
  albumArtist: 'Various Artists',
});

const matcher = new TrackMatcher([
  heyJude,
  letItBe,
  letItBeLive,
  hurtNin,
  hurtCash,
  joga,
  satisfaction,
  featured,
  untagged,
  sameSongOnCompilation,
]);

describe('normalizing song names', () => {
  it('folds case, accents, punctuation, and apostrophes', () => {
    expect(normalizeText('  Björk — Jóga!  ')).toBe('bjork joga');
    expect(normalizeText("Don't Stop Me Now")).toBe('dont stop me now');
    expect(normalizeText('Simon & Garfunkel')).toBe('simon and garfunkel');
  });

  it('sets qualifiers aside but keeps brackets that belong to the name', () => {
    expect(splitTitle('Hey Jude - Remastered 2015').core).toBe('hey jude');
    expect(splitTitle('Song (feat. Someone) [Live]')).toMatchObject({ core: 'song', versions: new Set(['live']) });
    expect(splitTitle('Song feat. Someone').core).toBe('song');
    expect(splitTitle("(I Can't Get No) Satisfaction").core).toBe('i cant get no satisfaction');
  });

  it('names untagged songs after their file, without the track number', () => {
    expect(fileTitle('03 - Teardrop.mp3')).toBe('Teardrop');
    expect(fileTitle('12. Song.flac')).toBe('Song');
    expect(fileTitle('07 Song.flac')).toBe('Song');
    expect(fileTitle('1-03 Song.flac')).toBe('Song');
    expect(fileTitle('1999.flac')).toBe('1999');
    expect(fileTitle('50 Ways to Leave Your Lover.flac')).toBe('50 Ways to Leave Your Lover');
    expect(fileTitle('99.flac')).toBe('99');
  });
});

describe('matching requested songs', () => {
  it('finds a song despite remaster qualifiers, case, and a missing "The"', () => {
    expect(matcher.match({ title: 'hey jude', artist: 'Beatles' })).toMatchObject({
      confidence: 'exact',
      match: heyJude,
    });
  });

  it('ignores accents and featured artists', () => {
    expect(matcher.match({ title: 'Joga', artist: 'Bjork' })).toMatchObject({ confidence: 'exact', match: joga });
    expect(matcher.match({ title: 'Empire State of Mind', artist: 'Jay-Z' })).toMatchObject({
      confidence: 'exact',
      match: featured,
    });
  });

  it('prefers the version asked for, and offers other releases as alternatives', () => {
    const studio = matcher.match({ title: 'Let It Be', artist: 'The Beatles' });
    expect(studio.confidence).toBe('exact');
    expect([letItBe, sameSongOnCompilation]).toContain(studio.match);
    expect(studio.alternatives).toContain(letItBeLive);

    expect(matcher.match({ title: 'Let It Be (Live)', artist: 'The Beatles' }).match).toBe(letItBeLive);
  });

  it('is unsure about another version of the song, rather than calling it the same', () => {
    const onlyLive = new TrackMatcher([letItBeLive]).match({ title: 'Let It Be', artist: 'The Beatles' });
    expect(onlyLive).toMatchObject({ confidence: 'ambiguous', match: letItBeLive });
  });

  it('uses the artist to tell apart songs that share a title, and is unsure without one', () => {
    expect(matcher.match({ title: 'Hurt', artist: 'Johnny Cash' })).toMatchObject({
      confidence: 'exact',
      match: hurtCash,
    });
    const either = matcher.match({ title: 'Hurt' });
    expect(either.confidence).toBe('ambiguous');
    expect([either.match, ...either.alternatives]).toEqual(expect.arrayContaining([hurtNin, hurtCash]));
  });

  it('does not accept a same-titled song by another artist', () => {
    const cover = matcher.match({ title: 'Hurt', artist: 'Leona Lewis' });
    expect(cover.confidence === 'ambiguous' || cover.confidence === 'none').toBe(true);
  });

  it('tolerates a misspelled title', () => {
    expect(matcher.match({ title: 'Hey Juude', artist: 'The Beatles' })).toMatchObject({
      confidence: 'likely',
      match: heyJude,
    });
  });

  it('falls back to file and folder names for untagged songs', () => {
    expect(matcher.match({ title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine' })).toMatchObject({
      confidence: 'exact',
      match: untagged,
    });
  });

  it('matches an untagged title that starts with a number', () => {
    const monkeys = track({ name: '12 Monkeys.flac', folders: ['Music', 'Soundtracks'] });
    expect(new TrackMatcher([monkeys]).match({ title: '12 Monkeys' })).toMatchObject({
      confidence: 'exact',
      match: monkeys,
    });
  });

  it('keeps brackets that are part of a title', () => {
    expect(matcher.match({ title: "(I Can't Get No) Satisfaction", artist: 'Rolling Stones' }).match).toBe(
      satisfaction,
    );
  });

  it('reports songs the library does not have', () => {
    expect(matcher.match({ title: 'Bohemian Rhapsody', artist: 'Queen' })).toEqual({
      confidence: 'none',
      match: null,
      alternatives: [],
    });
  });
});
