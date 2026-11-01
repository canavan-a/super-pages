// The scroll the logo sits on: one sheet of parchment hanging from a rod,
// its sides a little ragged and its bottom corners curled up, built here as
// tone runs (the same sub-pixels and tones as the wordmark) sized to fit the
// stacked wordmark, so the splash can drop it and write the words on it.
import {LOGO, ToneRuns} from './logoData';

/** Parchment margin around the wordmark, in sub-pixels. */
const PAD_X = 8;
const PAD_Y = 6;
/** How far the rod's knobs reach past the sheet on each side. */
const KNOB = 3;
const ROD_ROWS = 5;
/** The corner curl at rest, in rows; the splash springs it flat and back. */
export const CURL_REST = 4;

const sheetW = LOGO.width + 2 * PAD_X;
const sheetH = LOGO.word.rows + 2 * PAD_Y;
const width = sheetW + 2 * KNOB;

/** Cells (x, y, u, w) grouped into tone runs. */
function toRuns(cells: [number, number, number, number][]): ToneRuns[] {
  const by = new Map<
    string,
    {u: number; w: number; rows: Map<number, number[]>}
  >();
  for (const [x, y, u, w] of cells) {
    const k = `${u}/${w}`;
    if (!by.has(k)) by.set(k, {u, w, rows: new Map()});
    const rows = by.get(k)!.rows;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y)!.push(x);
  }
  return Array.from(by.values(), ({u, w, rows}) => {
    const runs: number[] = [];
    for (const [y, xs] of Array.from(rows).sort((a, b) => a[0] - b[0])) {
      xs.sort((a, b) => a - b);
      for (let i = 0; i < xs.length; ) {
        let n = 1;
        while (xs[i + n] === xs[i] + n) n++;
        runs.push(xs[i], y, n);
        i += n;
      }
    }
    return {u, w, runs};
  });
}

/** Repeatable randomness, so the sheet looks the same everywhere. */
function rng(seed: number) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// Each row's sides step in by a sub-pixel now and then: a hand-cut edge.
const rag: [number, number][] = [];
{
  const r = rng(21);
  let l = 0;
  let rt = 0;
  for (let y = 0; y < sheetH; y++) {
    if (r() < 0.35) l = l ? 0 : 1;
    if (r() < 0.35) rt = rt ? 0 : 1;
    rag.push([l, rt]);
  }
}

// The sheet: surface tone, a darker rim on the sides and bottom, the rod's
// shadow across the top, and a few fibres.
const sheetCells: [number, number, number, number][] = [];
{
  const fibre = rng(4);
  for (let y = 0; y < sheetH; y++) {
    const [l, r] = rag[y];
    for (let x = l; x < sheetW - r; x++) {
      const rim = x === l || x === sheetW - r - 1 || y === sheetH - 1;
      let u = rim ? 2 : 1;
      if (!rim && y < 3) u = [1.7, 1.4, 1.15][y];
      if (!rim && fibre() < 0.012) u = 1.3;
      sheetCells.push([x, y, u, 0]);
    }
  }
}

/**
 * The bottom corners curled up, `size` rows tall: a triangle of the back of
 * the paper at each, lighter toward the fold. In the sheet's coordinates.
 */
function curl(size: number): ToneRuns[] {
  const cells: [number, number, number, number][] = [];
  const [l, r] = rag[sheetH - 1];
  for (let k = 0; k < size; k++) {
    const y = sheetH - 1 - (size - 1 - k);
    for (let j = 0; j <= k * 2; j++) {
      const u =
        j === k * 2 ? 2.8 : Math.round((2 + (j / (k * 2 + 1)) * 0.5) * 12) / 12;
      cells.push([l + j, y, u, 0], [sheetW - 1 - r - j, y, u, 0]);
    }
  }
  return toRuns(cells);
}

// The rod, in the accent: three rows across, its knobs five rows tall.
const rodCells: [number, number, number, number][] = [];
{
  const tones: [number, number][] = [
    [3.8333, 0.5],
    [4, 1],
    [4, 1],
    [4, 0.5],
    [3.6, 0.5],
  ];
  for (let y = 0; y < ROD_ROWS; y++) {
    for (let x = 0; x < width; x++) {
      const knob = x < KNOB || x >= width - KNOB;
      const edgeRow = y === 0 || y === ROD_ROWS - 1;
      if (edgeRow && (!knob || x === 0 || x === width - 1)) continue;
      rodCells.push([x, y, ...tones[y]]);
    }
  }
}

export const SCROLL = {
  /** Total size in sub-pixels, open. */
  width,
  height: ROD_ROWS + sheetH,
  rod: {rows: ROD_ROWS, tones: toRuns(rodCells)},
  sheet: {
    x: KNOB,
    y: ROD_ROWS,
    w: sheetW,
    h: sheetH,
    tones: toRuns(sheetCells),
  },
  /** The corner curls by size (1..CURL_REST rows), in the sheet's coordinates. */
  curls: Array.from({length: CURL_REST + 1}, (_, size) => curl(size)),
  /** Where the wordmark sits, in sub-pixels. */
  word: {x: KNOB + PAD_X, y: ROD_ROWS + PAD_Y},
};
