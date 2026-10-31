// The scroll the logo sits on: two rollers and the parchment between them,
// built here as tone runs (the same sub-pixels and tones as art/mark.txt,
// which is the launcher icon) but sized to fit the stacked wordmark, so the
// splash can unroll it and the words appear written on it.
import {LOGO, ToneRuns} from './logoData';

// The art legend's tones (tools/appart): rollers, parchment.
const TONES: Record<string, {u: number; w: number}> = {
  A: {u: 4, w: 1},
  B: {u: 3.8333, w: 0.5},
  C: {u: 4, w: 0.5},
  '1': {u: 1, w: 0},
  '2': {u: 1.5, w: 0},
  '3': {u: 2, w: 0},
};

function runsOf(grid: string[]): ToneRuns[] {
  const by = new Map<string, number[]>();
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x];
      if (c === '.') {
        x++;
        continue;
      }
      let n = 1;
      while (row[x + n] === c) n++;
      if (!by.has(c)) by.set(c, []);
      by.get(c)!.push(x, y, n);
      x += n;
    }
  });
  return Array.from(by, ([c, runs]) => ({...TONES[c], runs}));
}

/** Parchment margin around the wordmark, in sub-pixels. */
const PAD_X = 7;
const PAD_Y = 5;
/** How far the rollers reach past the parchment on each side. */
const KNOB = 4;
const ROLLER_ROWS = 5;

const parchW = LOGO.width + 2 * PAD_X;
const parchH = LOGO.word.rows + 2 * PAD_Y;
const width = parchW + 2 * KNOB;
const inner = width - 2 * KNOB;

const roller = [
  '.AAA' + '.'.repeat(inner) + 'AAA.',
  'AAAA' + 'B'.repeat(inner) + 'AAAA',
  'AAAA' + 'A'.repeat(inner) + 'AAAA',
  'AAAA' + 'C'.repeat(inner) + 'AAAA',
  '.AAA' + '.'.repeat(inner) + 'AAA.',
];

const parchment = Array.from(
  {length: parchH},
  (_, y) => '3' + (y === 0 ? '2' : '1').repeat(parchW - 2) + '3',
);

export const SCROLL = {
  /** Total size in sub-pixels, open. */
  width,
  height: ROLLER_ROWS * 2 + parchH,
  roller: {rows: ROLLER_ROWS, tones: runsOf(roller)},
  parchment: {
    x: KNOB,
    y: ROLLER_ROWS,
    w: parchW,
    h: parchH,
    tones: runsOf(parchment),
  },
  /** Where the wordmark sits, in sub-pixels. */
  word: {x: KNOB + PAD_X, y: ROLLER_ROWS + PAD_Y},
};
