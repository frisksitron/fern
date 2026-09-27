import { describe, expect, it } from 'vitest';
import { assToVtt } from '../../src/lib/server/playback/ass';

const header = `[Script Info]
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV
Style: Default,Noto Serif,69,&H00FFFFFF,0,0,2,0,0,40
Style: Italics,Noto Serif,69,&H00FFFFFF,0,-1,2,0,0,40
Style: Top-Alt,Noto Serif,69,&H00FFFFFF,0,0,8,0,0,40

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

const cues = (vtt: string) => vtt.trimEnd().split('\n\n').slice(1);

describe('assToVtt', () => {
  it('keeps dialogue, with line breaks, italics, and escaped text', () => {
    const vtt = assToVtt(
      header +
        [
          "Dialogue: 0,0:01:30.93,0:01:38.75,Default,Frieren,0,0,0,,Let's see, long-range magic\\Nuses {\\i1}three{\\i0} qualities.",
          'Dialogue: 0,0:01:39.35,0:01:41.06,Italics,,0,0,0,,A <thought>, & more',
        ].join('\n'),
    );
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(cues(vtt)).toEqual([
      "00:01:30.930 --> 00:01:38.750\nLet's see, long-range magic\nuses <i>three</i> qualities.",
      '00:01:39.350 --> 00:01:41.060\n<i>A &lt;thought&gt;, &amp; more</i>',
    ]);
  });

  it('drops karaoke effects, drawings, texture layers, and empty events, and collapses stacked layers', () => {
    const vtt = assToVtt(
      header +
        [
          'Dialogue: 5,0:00:03.14,0:00:05.46,Default,,0,0,0,fx,{\\an5\\pos(1191,1023)}in',
          'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
          'Dialogue: 0,0:00:00.00,0:00:00.53,Default,,0,0,0,,{\\fad(100,100)}',
          'Dialogue: 1,0:02:00.00,0:02:02.00,Default,,0,0,0,,{\\an8\\pos(960,120)\\bord4}Village of Mages',
          'Dialogue: 2,0:02:00.00,0:02:02.00,Default,,0,0,0,,{\\an8\\pos(960,120)\\bord0}Village of Mages',
          'Dialogue: 3,0:02:00.00,0:02:01.50,Default,,0,0,0,,{\\an8\\pos(962,121)\\blur3}Village of Mages',
          'Dialogue: 4,0:02:00.00,0:02:02.00,Default,,0,0,0,,{\\pos(960,736)\\fnGrain\\1a&HFE&}P3cmCn8aUpUoDQ',
        ].join('\n'),
    );
    expect(cues(vtt)).toEqual([
      '00:02:00.000 --> 00:02:02.000 position:50.00% line:11.11% align:center\n<c.sign>Village of Mages</c>',
    ]);
  });

  it('merges sign lines stacked below one another into one cue', () => {
    const vtt = assToVtt(
      header +
        [
          'Dialogue: 0,0:11:26.71,0:11:32.21,Default,,0,0,0,,{\\an9\\pos(1530,210)}26 years after the death',
          'Dialogue: 0,0:11:26.71,0:11:32.21,Default,,0,0,0,,{\\an9\\pos(1530,247)}of Himmel the Hero',
          'Dialogue: 0,0:11:26.71,0:11:32.21,Default,,0,0,0,,{\\an9\\pos(700,210)}Elsewhere',
        ].join('\n'),
    );
    expect(cues(vtt)).toEqual([
      '00:11:26.710 --> 00:11:32.210 position:79.69% line:19.44% align:right\n<c.sign>26 years after the death\nof Himmel the Hero</c>',
      '00:11:26.710 --> 00:11:32.210 position:36.46% line:19.44% align:right\n<c.sign>Elsewhere</c>',
    ]);
  });

  it('joins a motion-tracked sign repeated frame by frame into one cue', () => {
    const vtt = assToVtt(
      header +
        [
          'Dialogue: 0,0:01:29.98,0:01:30.02,Default,,0,0,0,,{\\an9\\pos(1500,120)}At the far northern edge',
          'Dialogue: 0,0:01:30.02,0:01:30.06,Default,,0,0,0,,{\\an9\\pos(1500,121)}At the far northern edge',
          'Dialogue: 0,0:01:30.06,0:01:33.00,Default,,0,0,0,,{\\an9\\pos(1500,122)}At the far northern edge',
          'Dialogue: 0,0:01:40.00,0:01:42.00,Default,,0,0,0,,{\\an9\\pos(1500,120)}At the far northern edge',
        ].join('\n'),
    );
    expect(cues(vtt).map((cue) => cue.split(' ').slice(0, 3).join(' '))).toEqual([
      '00:01:29.980 --> 00:01:33.000',
      '00:01:40.000 --> 00:01:42.000',
    ]);
  });

  it('places cues by style alignment when they have no position', () => {
    const vtt = assToVtt(header + 'Dialogue: 0,0:00:10.00,0:00:12.00,Top-Alt,,0,0,0,,Over here');
    expect(cues(vtt)).toEqual(['00:00:10.000 --> 00:00:12.000 line:0 align:center\nOver here']);
  });

  it('orders cues by start time', () => {
    const vtt = assToVtt(
      header +
        [
          'Dialogue: 0,0:00:20.00,0:00:21.00,Default,,0,0,0,,Second',
          'Dialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,First',
        ].join('\n'),
    );
    expect(cues(vtt).map((cue) => cue.split('\n')[1])).toEqual(['First', 'Second']);
  });
});
