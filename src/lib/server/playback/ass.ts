/**
 * Converts ASS/SSA subtitles to WebVTT for the browser's native captions.
 *
 * Fansub tracks mix dialogue with typesetting: karaoke effects generated per syllable, vector
 * drawings, texture layers, and signs placed next to on-screen text, often in several stacked
 * layers. WebVTT can place a cue but cannot draw effects, so:
 *
 * - effect events, drawings, and nearly transparent layers are dropped;
 * - layers repeating a line that is already shown, and signs repeated frame by frame to follow
 *   the picture, collapse into one cue;
 * - positioned events become signs: cues placed where the typesetter put them, drawn smaller
 *   (`::cue(.sign)` in app.css), with lines stacked below one another merged into one cue.
 */

type Style = { readonly alignment: number; readonly italic: boolean };

type Cue = {
  readonly start: string;
  /** Extended while later layers or frames continue the same text. */
  end: string;
  readonly lines: string[];
  /** Numpad alignment: 1–3 bottom, 4–6 middle, 7–9 top; left, center, right. */
  readonly alignment: number;
  /** For signs, where the top of the cue goes, in percent of the video. */
  readonly sign: { readonly x: number; readonly top: number } | null;
};

const defaultStyle: Style = { alignment: 2, italic: false };

/** Browsers draw each caption line about 5% of the video's height tall. */
const LINE_HEIGHT_PERCENT = 5;
/** Signs are drawn at this fraction of the caption size, close to what typesetters space them for. */
const SIGN_SCALE = 0.65;
const SIGN_LINE_PERCENT = LINE_HEIGHT_PERCENT * SIGN_SCALE;

/** `H:MM:SS.cc` to WebVTT's `HH:MM:SS.mmm`. */
function timestamp(value: string) {
  const match = /^(\d+):(\d\d):(\d\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction = '0'] = match;
  return `${hours.padStart(2, '0')}:${minutes}:${seconds}.${fraction.padEnd(3, '0')}`;
}

/** Splits a `Format:`-described line into named fields; the last field keeps any commas. */
function fields(format: readonly string[], value: string) {
  const parts = value.split(',');
  const head = parts.slice(0, format.length - 1);
  const tail = parts.slice(format.length - 1).join(',');
  return Object.fromEntries([...head, tail].map((part, index) => [format[index], part.trim()]));
}

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The visible lines as WebVTT cue text: override blocks removed, except italics. */
function cueLines(raw: string, italicStyle: boolean) {
  let italic = italicStyle;
  let text = italic ? '<i>' : '';
  for (const part of raw.split(/(\{[^}]*\})/)) {
    if (part.startsWith('{') && part.endsWith('}')) {
      const toggle = /\\i([01])(?![0-9])/.exec(part)?.[1];
      if (toggle === '1' && !italic) ((text += '<i>'), (italic = true));
      if (toggle === '0' && italic) ((text += '</i>'), (italic = false));
      continue;
    }
    text += escape(part.replaceAll('\\N', '\n').replaceAll('\\n', ' ').replaceAll('\\h', '\u00a0'));
  }
  if (italic) text += '</i>';
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line.replace(/<\/?i>/g, '').trim());
}

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const percent = (value: number) => clamp(value).toFixed(2);
const column = (alignment: number) => (alignment - 1) % 3; // 0 left, 1 center, 2 right
const row = (alignment: number) => Math.floor((alignment - 1) / 3); // 0 bottom, 1 middle, 2 top

/**
 * Chrome ignores a `line` setting that names a line alignment, so cues are placed by their top. An
 * ASS position anchors the bottom, middle, or top of the text, depending on the alignment.
 */
function signTop(alignment: number, y: number, lines: number) {
  return y - lines * SIGN_LINE_PERCENT * [1, 0.5, 0][row(alignment)];
}

/** Whether `next` continues `sign` one line further down, as typesetters split multi-line signs. */
function continues(sign: Cue, next: Cue) {
  if (!sign.sign || !next.sign) return false;
  if (sign.start !== next.start || sign.end !== next.end || sign.alignment !== next.alignment) return false;
  const expectedTop = sign.sign.top + sign.lines.length * SIGN_LINE_PERCENT;
  return Math.abs(sign.sign.x - next.sign.x) <= 1.5 && Math.abs(next.sign.top - expectedTop) <= SIGN_LINE_PERCENT;
}

function render(cue: Cue) {
  const align = ['left', 'center', 'right'][column(cue.alignment)];
  const text = cue.lines.join('\n');
  if (cue.sign) {
    const settings = `position:${percent(cue.sign.x)}% line:${percent(cue.sign.top)}% align:${align}`;
    return `${cue.start} --> ${cue.end} ${settings}\n<c.sign>${text}</c>`;
  }
  const middle = percent(50 - (cue.lines.length * LINE_HEIGHT_PERCENT) / 2);
  const settings = [
    row(cue.alignment) === 2 ? 'line:0' : row(cue.alignment) === 1 ? `line:${middle}%` : '',
    align === 'center' && row(cue.alignment) === 0 ? '' : `align:${align}`,
  ].filter(Boolean);
  return `${cue.start} --> ${cue.end}${settings.length ? ` ${settings.join(' ')}` : ''}\n${text}`;
}

export function assToVtt(ass: string): string {
  let section = '';
  let play: [number, number] = [384, 288];
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];
  const styles = new Map<string, Style>();
  const cues: Cue[] = [];
  /** The cues showing each text, so stacked layers and repeated frames of one line become one cue. */
  const shown = new Map<string, Cue[]>();

  for (const line of ass.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      section = trimmed.toLowerCase();
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator < 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1);

    if (section === '[script info]') {
      if (name === 'PlayResX') play = [Number(value) || play[0], play[1]];
      if (name === 'PlayResY') play = [play[0], Number(value) || play[1]];
    } else if (section === '[v4+ styles]' || section === '[v4 styles]') {
      if (name === 'Format') styleFormat = value.split(',').map((field) => field.trim());
      if (name === 'Style' && styleFormat.length) {
        const style = fields(styleFormat, value);
        styles.set(style.Name, {
          alignment: Number(style.Alignment) || defaultStyle.alignment,
          italic: style.Italic === '-1' || style.Italic === '1',
        });
      }
    } else if (section === '[events]') {
      if (name === 'Format') eventFormat = value.split(',').map((field) => field.trim());
      if (name !== 'Dialogue' || !eventFormat.length) continue;
      const event = fields(eventFormat, value);
      const text = event.Text ?? '';
      // Effects (karaoke and scrolling) and vector drawings cannot be shown as captions.
      if (event.Effect || /\\p[1-9]/.test(text)) continue;
      const overrides = text.match(/\{[^}]*\}/g)?.join('') ?? '';
      // A nearly transparent fill is a glow, shadow, or texture layer under another line.
      const fillAlpha = /\\(?:1a|alpha)&H([0-9a-f]{2})/i.exec(overrides)?.[1];
      if (fillAlpha && parseInt(fillAlpha, 16) >= 0xf0) continue;
      const start = timestamp(event.Start ?? '');
      const end = timestamp(event.End ?? '');
      if (!start || !end || end <= start) continue;
      const style = styles.get(event.Style) ?? defaultStyle;
      const lines = cueLines(text, style.italic);
      if (!lines.length) continue;
      const content = lines.join('\n');
      // A layer of a line already shown, or a motion-tracked sign repeated frame by frame, extends
      // the cue that shows it instead of adding another.
      const same = shown.get(content) ?? [];
      const showing = same.find((cue) => start <= cue.end && cue.start <= end);
      if (showing) {
        if (end > showing.end) showing.end = end;
        continue;
      }
      const alignment = Number(/\\an([1-9])/.exec(overrides)?.[1] ?? style.alignment);
      const placed = /\\(?:pos|move)\(\s*([-\d.]+)\s*,\s*([-\d.]+)/.exec(overrides);
      const sign = placed
        ? {
            x: clamp((Number(placed[1]) / play[0]) * 100),
            top: signTop(alignment, (Number(placed[2]) / play[1]) * 100, lines.length),
          }
        : null;
      const cue: Cue = { start, end, lines, alignment, sign };
      cues.push(cue);
      shown.set(content, [...same, cue]);
    }
  }

  // Merge sign lines stacked directly below one another into one cue, so their boxes cannot overlap.
  const signs = cues
    .filter((cue) => cue.sign)
    .sort((a, b) => a.start.localeCompare(b.start) || a.sign!.top - b.sign!.top);
  const merged: Cue[] = [];
  for (const sign of signs) {
    const above = merged.findLast((cue) => cue.start === sign.start && continues(cue, sign));
    if (above) above.lines.push(...sign.lines);
    else merged.push({ ...sign, lines: [...sign.lines] });
  }

  const all = [...cues.filter((cue) => !cue.sign), ...merged];
  all.sort((a, b) => a.start.localeCompare(b.start));
  return `WEBVTT\n\n${all.map(render).join('\n\n')}\n`;
}
