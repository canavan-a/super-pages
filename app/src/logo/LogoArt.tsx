import React, {memo} from 'react';
import {StyleSheet, View} from 'react-native';
import Svg, {G, Path} from 'react-native-svg';

import {LOGO, ToneRuns} from './logoData';
import {SCROLL} from './scroll';
import {toneColor} from './logoTheme';
import {useTheme} from '../theme';

// The art's sub-pixels aren't square: in the terminal a sextant is half a cell
// wide and a third of a cell tall, and a cell is about twice as tall as wide,
// so a sub-pixel is 3 wide by 4 tall. The logo keeps that shape everywhere.
export const PIXEL_W = 3;
export const PIXEL_H = 4;

/** The stacked wordmark's size in viewBox units. */
export const WORD_W = LOGO.width * PIXEL_W;
export const WORD_H = LOGO.word.rows * PIXEL_H;
/** The whole logo: the open scroll with the wordmark on it (scroll.ts). */
export const LOGO_W = SCROLL.width * PIXEL_W;
export const LOGO_H = SCROLL.height * PIXEL_H;
/** Where the wordmark sits on the scroll, in viewBox units. */
export const WORD_X = SCROLL.word.x * PIXEL_W;
export const WORD_Y = SCROLL.word.y * PIXEL_H;
export const ROLLER_H = SCROLL.roller.rows * PIXEL_H;
export const PARCH = {
  x: SCROLL.parchment.x * PIXEL_W,
  y: SCROLL.parchment.y * PIXEL_H,
  w: SCROLL.parchment.w * PIXEL_W,
  h: SCROLL.parchment.h * PIXEL_H,
};

// Adjacent rectangles overlap by a hair so no seams show between pixels when
// the logo is scaled to a fractional size.
const OVERLAP = 0.35;

const pathCache = new WeakMap<ToneRuns, string>();

/** One tone's runs as a single SVG path of rectangles. */
export function tonePath(t: ToneRuns): string {
  const cached = pathCache.get(t);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  for (let i = 0; i < t.runs.length; i += 3) {
    const x = t.runs[i] * PIXEL_W;
    const y = t.runs[i + 1] * PIXEL_H;
    const w = t.runs[i + 2] * PIXEL_W + OVERLAP;
    parts.push(`M${x} ${y}h${w}v${PIXEL_H + OVERLAP}h${-w}z`);
  }
  const d = parts.join('');
  pathCache.set(t, d);
  return d;
}

/** Merges tone groups that share a tone (same u and w) into one. */
export function mergeTones(...groups: ToneRuns[][]): ToneRuns[] {
  const merged = new Map<string, ToneRuns>();
  for (const g of groups) {
    for (const t of g) {
      const key = `${t.u}/${t.w}`;
      const m = merged.get(key);
      if (m) m.runs = m.runs.concat(t.runs);
      else merged.set(key, {u: t.u, w: t.w, runs: t.runs.slice()});
    }
  }
  return Array.from(merged.values());
}

/** Every slice of the wordmark's tones merged, for drawing it in one piece. */
export const WORD_TONES: ToneRuns[] = mergeTones(
  ...LOGO.word.slices.map(s => s.tones),
);

/** The runs of each tone clipped to the columns [x0, x1). Tones left empty are dropped. */
export function sliceTones(
  tones: ToneRuns[],
  x0: number,
  x1: number,
): ToneRuns[] {
  const out: ToneRuns[] = [];
  for (const t of tones) {
    const runs: number[] = [];
    for (let i = 0; i < t.runs.length; i += 3) {
      const start = Math.max(t.runs[i], x0);
      const end = Math.min(t.runs[i] + t.runs[i + 2], x1);
      if (end > start) runs.push(start, t.runs[i + 1], end - start);
    }
    if (runs.length) out.push({u: t.u, w: t.w, runs});
  }
  return out;
}

/** How many vertical strips the shine is cut into. */
export const SHINE_STRIPS = 16;

/** The strips' column spans, tiling the logo's width exactly. */
export const STRIP_SPANS: {x0: number; x1: number}[] = Array.from(
  {length: SHINE_STRIPS},
  (_, i) => ({
    x0: Math.round((i * LOGO.width) / SHINE_STRIPS),
    x1: Math.round(((i + 1) * LOGO.width) / SHINE_STRIPS),
  }),
);

/** Each strip's share of the wordmark. */
export const WORD_STRIPS = STRIP_SPANS.map(s => ({
  ...s,
  tones: sliceTones(WORD_TONES, s.x0, s.x1),
}));

// Every layer sits at the origin of its container and overlays its siblings.
// (Without this the SVGs are flex children and *stack*: on the web an <svg>
// in a flex column also shrinks to share the height, which squeezed the mark
// to half size and pushed its details out of line with the shine's copy.)
const styles = StyleSheet.create({
  layer: {position: 'absolute', top: 0, left: 0},
});

interface LayerProps {
  tones: ToneRuns[];
  /** the fill color for a tone */
  fill: (t: ToneRuns) => string;
  /** the part of the logo to show: x, y, width, height in viewBox units */
  view: [number, number, number, number];
  /** rendered size in pixels */
  width: number;
  height: number;
}

/** A group of tones drawn as SVG. */
export const ToneLayer = memo(function ToneLayer({
  tones,
  fill,
  view,
  width,
  height,
}: LayerProps) {
  return (
    <Svg
      style={styles.layer}
      width={width}
      height={height}
      viewBox={view.join(' ')}>
      {tones.map(t => (
        <Path key={`${t.u}/${t.w}`} d={tonePath(t)} fill={fill(t)} />
      ))}
    </Svg>
  );
});

interface FullProps {
  fill: (t: ToneRuns) => string;
  width: number;
  height: number;
}

/** The whole logo (the open scroll, the stacked wordmark on it) in one SVG. */
export const FullLogo = memo(function FullLogo({
  fill,
  width,
  height,
}: FullProps) {
  return (
    <Svg
      style={styles.layer}
      width={width}
      height={height}
      viewBox={`0 0 ${LOGO_W} ${LOGO_H}`}>
      <G>
        {SCROLL.roller.tones.map(t => (
          <Path key={`rt${t.u}/${t.w}`} d={tonePath(t)} fill={fill(t)} />
        ))}
      </G>
      <G transform={`translate(${PARCH.x} ${PARCH.y})`}>
        {SCROLL.parchment.tones.map(t => (
          <Path key={`p${t.u}/${t.w}`} d={tonePath(t)} fill={fill(t)} />
        ))}
      </G>
      <G transform={`translate(0 ${LOGO_H - ROLLER_H})`}>
        {SCROLL.roller.tones.map(t => (
          <Path key={`rb${t.u}/${t.w}`} d={tonePath(t)} fill={fill(t)} />
        ))}
      </G>
      <G transform={`translate(${WORD_X} ${WORD_Y})`}>
        {WORD_TONES.map(t => (
          <Path key={`w${t.u}/${t.w}`} d={tonePath(t)} fill={fill(t)} />
        ))}
      </G>
    </Svg>
  );
});

/** The logo at rest, in the current theme's colors (onboarding, lock screen). Sized by height. */
export function LogoArt({height}: {height: number}): React.JSX.Element {
  const theme = useTheme();
  const width = (height * LOGO_W) / LOGO_H;
  return (
    <View style={{width, height}} accessible accessibilityLabel="Super Pages">
      <FullLogo
        fill={t => toneColor(theme, t.u, t.w)}
        width={width}
        height={height}
      />
    </View>
  );
}

/** "Super Pages" on one line in the logo's own pixel lettering and theme colors (the page list's header). */
export function LogoLine({height}: {height: number}): React.JSX.Element {
  const theme = useTheme();
  const viewW = LOGO.line.w * PIXEL_W;
  const viewH = LOGO.line.h * PIXEL_H;
  const width = (height * viewW) / viewH;
  return (
    <View
      style={{width, height}}
      accessible
      accessibilityRole="header"
      accessibilityLabel="Super Pages">
      <ToneLayer
        tones={LOGO.line.tones}
        fill={t => toneColor(theme, t.u, t.w)}
        view={[0, 0, viewW, viewH]}
        width={width}
        height={height}
      />
    </View>
  );
}
