import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

import type {Theme} from '../theme';
import {
  LETTER_STRIPS,
  LOGO_H,
  LOGO_W,
  PIXEL_W,
  ROD_H,
  SHEET,
  SHINE_STRIPS,
  ToneLayer,
  WORD_H,
  WORD_STRIPS,
  WORD_W,
  WORD_X,
  WORD_Y,
} from './LogoArt';
import {CURL_REST, SCROLL} from './scroll';
import {LOGO, ToneRuns} from './logoData';
import {shineColor, toneColor} from './logoTheme';

// The launch screen, recolored for the current theme: a sheet of parchment
// drops from its rod, the curl at its bottom corners springs flat and back,
// "Super Pages" is written on it a letter at a time, left to right, then a
// shine sweeps across.
//
// Everything animated is an opacity or a translate/scale on the native driver,
// and nothing else: no skew, no clipping, no layers moving against each other.
// (The shine used to be a slanted, clipped window sliding over a counter-moving
// copy of the logo. React Native on Android drops skew from view transforms
// anyway, so it could never look right there, and it was the riskiest part of
// the screen.) The shine is now a row of thin strips of a lightened copy of the
// logo, each fading in and out as the sweep passes it.

/** Timeline, in milliseconds. */
export const SPLASH_TIMING = {
  unrollStart: 120,
  unrollDur: 600,
  curlStart: 680,
  curlDur: 320,
  letterStart: 1000,
  letterStagger: 70,
  letterDur: 200,
  shineStart: 1850,
  shineDur: 780,
  hold: 2650, // when the exit fade begins
  exit: 350,
};

/** How long writing the whole word takes. */
const WRITE_DUR =
  (LOGO.word.slices.length - 1) * SPLASH_TIMING.letterStagger +
  SPLASH_TIMING.letterDur;

/** How long one strip of a letter takes to appear once the pen reaches it. */
const STROKE_MS = 40;

/** When (0..1 of the writing) strip s of the wordmark appears. */
export function writeRange(s: {letter: number; at: number}): [number, number] {
  const T = SPLASH_TIMING;
  const eps = STROKE_MS / WRITE_DUR;
  const t = (s.letter * T.letterStagger + s.at * T.letterDur) / WRITE_DUR;
  const a = Math.min(t, 1 - eps);
  return [a, a + eps];
}

/**
 * The corner curl's size through its spring (0..1): at rest, flattening to
 * a single row, and back. The input/output ranges for showing the layer of
 * the given size, as near-steps (an interpolation can't jump).
 */
export function curlRange(size: number): {input: number[]; output: number[]} {
  // The curl is round(REST - (REST - 1) sin(pi p)) rows at p: it shows this
  // size while sin(pi p) is between these two...
  const R = CURL_REST;
  const sLow = (R - size - 0.5) / (R - 1);
  const sHigh = (R - size + 0.5) / (R - 1);
  // ...which happens from p = from to p = to on the way down, and mirrored on
  // the way back up.
  const at = (v: number) => Math.asin(v) / Math.PI;
  const from = sLow <= 0 ? 0 : at(Math.min(1, sLow));
  const to = sHigh >= 1 ? 0.5 : at(Math.max(0, sHigh));
  const spans: [number, number][] =
    to >= 0.5
      ? [[from, 1 - from]] // the flattest: one span across the middle
      : [
          [from, to],
          [1 - to, 1 - from],
        ];
  const eps = 0.004;
  const input: number[] = [];
  const output: number[] = [];
  const push = (x: number, y: number) => {
    input.push(x);
    output.push(y);
  };
  if (spans[0][0] > 0) push(0, 0);
  for (const [lo, hi] of spans) {
    if (lo > 0) {
      push(lo - eps, 0);
      push(lo, 1);
    } else push(0, 1);
    if (hi < 1) {
      push(hi, 1);
      push(hi + eps, 0);
    } else push(1, 1);
  }
  return {input, output};
}

/** How much of the way toward the shine target the highlight colors go. */
const SHINE_STRENGTH = 0.7;

/** How bright the highlight gets on the strip the sweep is over (its opacity). */
const SHINE_PEAK = 0.55;

/** Total running time. */
export const SPLASH_TOTAL = SPLASH_TIMING.hold + SPLASH_TIMING.exit;

/**
 * The shine's progress (0..1) at which the sweep is over strip i of n: the
 * strip fades up from nothing, peaks, and fades away. Strictly increasing, as
 * an interpolation's input range must be.
 */
export function pulseRange(
  i: number,
  n: number,
  lag: number,
): [number, number, number] {
  const c = 0.06 + (0.88 * i) / (n - 1) + lag;
  return [Math.max(0, c - 0.13), c, Math.min(1, c + 0.13)];
}

interface Props {
  theme: Theme;
  /** called when the splash has finished (or was tapped away) */
  onDone: () => void;
  /** skip the motion: hold the logo briefly, then fade */
  reduceMotion?: boolean;
  /** the app is still loading: stay up past the timeline until this goes false */
  hold?: boolean;
}

export function SplashScreen({
  theme,
  onDone,
  reduceMotion,
  hold = false,
}: Props): React.JSX.Element {
  const {width: screenW, height: screenH} = useWindowDimensions();
  // Kept modest, with plenty of space around it: at most 60% of the width and
  // 45% of the height (the stacked logo is a little taller than wide).
  const W = Math.min(screenW * 0.6, 320, (screenH * 0.45 * LOGO_W) / LOGO_H);
  const scale = W / LOGO_W;
  const H = LOGO_H * scale;
  const useNative = Platform.OS !== 'web';

  const [reduce, setReduce] = useState(reduceMotion ?? false);
  useEffect(() => {
    if (reduceMotion !== undefined) return;
    let alive = true;
    // Promise.resolve: never trust a platform API to hand back a promise.
    Promise.resolve(AccessibilityInfo.isReduceMotionEnabled?.())
      .then(v => alive && setReduce(!!v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [reduceMotion]);

  // Created once. (useRef({...}) would build a fresh set of Animated.Values on
  // every render and throw all but the first away.)
  const values = useRef<{
    unroll: Animated.Value;
    curl: Animated.Value;
    write: Animated.Value;
    shine: Animated.Value;
    exit: Animated.Value;
  } | null>(null);
  if (!values.current) {
    values.current = {
      unroll: new Animated.Value(reduce ? 1 : 0),
      curl: new Animated.Value(reduce ? 1 : 0),
      write: new Animated.Value(reduce ? 1 : 0),
      shine: new Animated.Value(0),
      exit: new Animated.Value(1),
    };
  }
  const v = values.current;

  const finished = useRef(false);
  const skipping = useRef(false);
  const running = useRef<Animated.CompositeAnimation | null>(null);
  const done = () => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  };
  // A tap fades the splash out rather than unmounting it on the spot: pulling
  // views out from under natively-driven animations that are still running is
  // a classic way to crash React Native on Android.
  const skip = () => {
    if (finished.current || skipping.current) return;
    skipping.current = true;
    running.current?.stop();
    Animated.timing(v.exit, {
      toValue: 0,
      duration: 160,
      easing: Easing.linear,
      useNativeDriver: useNative,
    }).start(done);
  };

  const timing = (
    val: Animated.Value,
    to: number,
    duration: number,
    delay: number,
    easing = Easing.out(Easing.cubic),
  ) =>
    Animated.timing(val, {
      toValue: to,
      duration,
      delay,
      easing,
      useNativeDriver: useNative,
    });

  // After the intro the splash fades out, unless the app is still loading
  // behind it (`hold`): then the shine keeps sweeping, as the loading
  // indicator, until it lets go. Refs, not state, so the fade starts in the
  // same tick the intro ends.
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const introDone = useRef(false);
  const exiting = useRef(false);
  const exitNow = () => {
    if (exiting.current || skipping.current) return;
    exiting.current = true;
    running.current?.stop();
    const T = SPLASH_TIMING;
    const exit = reduce
      ? timing(v.exit, 0, 200, 0, Easing.linear)
      : timing(v.exit, 0, T.exit, 0, Easing.in(Easing.quad));
    running.current = exit;
    exit.start(r => r.finished && done());
  };
  const afterIntro = () => {
    introDone.current = true;
    if (!holdRef.current) return exitNow();
    if (reduce) return; // just stay put
    const T = SPLASH_TIMING;
    v.shine.setValue(0);
    const loop = Animated.loop(
      Animated.sequence([
        timing(v.shine, 1, T.shineDur, 0, Easing.inOut(Easing.quad)),
        Animated.delay(250),
      ]),
    );
    running.current = loop;
    loop.start();
  };

  // The intro: the drop, the curl, the writing, one shine, then the rest of
  // the hold time.
  useEffect(() => {
    const T = SPLASH_TIMING;
    const animation = reduce
      ? Animated.delay(600)
      : Animated.parallel([
          timing(
            v.unroll,
            1,
            T.unrollDur,
            T.unrollStart,
            Easing.out(Easing.cubic),
          ),
          timing(v.curl, 1, T.curlDur, T.curlStart, Easing.linear),
          timing(v.write, 1, WRITE_DUR, T.letterStart, Easing.linear),
          timing(
            v.shine,
            1,
            T.shineDur,
            T.shineStart,
            Easing.inOut(Easing.quad),
          ),
          Animated.delay(T.hold),
        ]);
    running.current = animation;
    animation.start(r => r.finished && afterIntro());
    return () => {
      running.current?.stop();
      running.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);

  // Loading finished while the splash was holding: fade out now.
  useEffect(() => {
    if (!hold && introDone.current) exitNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold]);

  // colors for this theme
  const base = useMemo(
    () => (t: ToneRuns) => toneColor(theme, t.u, t.w),
    [theme],
  );
  const glint = useMemo(
    () => (t: ToneRuns) =>
      shineColor(toneColor(theme, t.u, t.w), theme, SHINE_STRENGTH),
    [theme],
  );

  // The shine's opacities, built once so their native nodes aren't recreated.
  const fades = useMemo(
    () =>
      WORD_STRIPS.map((_, i) =>
        v.shine.interpolate({
          inputRange: pulseRange(i, SHINE_STRIPS, 0),
          outputRange: [0, SHINE_PEAK, 0],
          extrapolate: 'clamp',
        }),
      ),
    [v],
  );

  const wordH = WORD_H * scale;
  const rodH = ROD_H * scale;
  const sheetH = SHEET.h * scale;
  // The sheet drops from the rod: it grows from a line under the rod to full
  // height, and the curled corners ride its bottom edge. Translate, scale
  // and opacity only, so it all runs on the native driver.
  const drop = useMemo(
    () => ({
      scale: v.unroll.interpolate({
        inputRange: [0, 1],
        outputRange: [0.001, 1],
      }),
      shift: v.unroll.interpolate({
        inputRange: [0, 1],
        outputRange: [-sheetH / 2, 0],
      }),
      bottom: v.unroll.interpolate({
        inputRange: [0, 1],
        outputRange: [-sheetH, 0],
      }),
      curlIn: v.unroll.interpolate({
        inputRange: [0, 0.15],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
    }),
    [v, sheetH],
  );
  const curls = useMemo(
    () =>
      SCROLL.curls.map((_, size) => {
        if (size === 0) return null;
        const {input, output} = curlRange(size);
        return v.curl.interpolate({
          inputRange: input,
          outputRange: output,
          extrapolate: 'clamp',
        });
      }),
    [v],
  );
  const strokes = useMemo(
    () =>
      LETTER_STRIPS.map(s =>
        v.write.interpolate({
          inputRange: writeRange(s),
          outputRange: [0, 1],
          extrapolate: 'clamp',
        }),
      ),
    [v],
  );
  const sheetBox = {
    left: SHEET.x * scale,
    top: SHEET.y * scale,
    width: SHEET.w * scale,
    height: sheetH,
  };

  const strips = () =>
    WORD_STRIPS.map((s, i) =>
      s.tones.length === 0 ? null : (
        <Animated.View
          key={`w${i}`}
          pointerEvents="none"
          style={[
            styles.abs,
            {
              left: s.x0 * PIXEL_W * scale,
              top: 0,
              width: (s.x1 - s.x0) * PIXEL_W * scale,
              height: wordH,
              opacity: fades[i],
            },
          ]}>
          <ToneLayer
            tones={s.tones}
            fill={glint}
            view={[s.x0 * PIXEL_W, 0, (s.x1 - s.x0) * PIXEL_W, WORD_H]}
            width={(s.x1 - s.x0) * PIXEL_W * scale}
            height={wordH}
          />
        </Animated.View>
      ),
    );

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFill,
        {backgroundColor: theme.bg, opacity: v.exit},
      ]}
      accessible
      accessibilityLabel="Super Pages">
      <Pressable
        style={styles.center}
        onPress={skip}
        accessibilityRole="button"
        accessibilityLabel="Skip intro">
        <View style={{width: W, height: H}}>
          <Animated.View
            style={[
              styles.abs,
              sheetBox,
              {transform: [{translateY: drop.shift}, {scaleY: drop.scale}]},
            ]}>
            <ToneLayer
              tones={SCROLL.sheet.tones}
              fill={base}
              view={[0, 0, SHEET.w, SHEET.h]}
              width={SHEET.w * scale}
              height={sheetH}
            />
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.abs,
              sheetBox,
              {opacity: drop.curlIn, transform: [{translateY: drop.bottom}]},
            ]}>
            {SCROLL.curls.map((tones, size) =>
              size === 0 ? null : (
                <Animated.View
                  key={size}
                  style={[
                    styles.abs,
                    {
                      width: SHEET.w * scale,
                      height: sheetH,
                      opacity: curls[size]!,
                    },
                  ]}>
                  <ToneLayer
                    tones={tones}
                    fill={base}
                    view={[0, 0, SHEET.w, SHEET.h]}
                    width={SHEET.w * scale}
                    height={sheetH}
                  />
                </Animated.View>
              ),
            )}
          </Animated.View>
          <View
            style={[
              styles.abs,
              {
                left: WORD_X * scale,
                top: WORD_Y * scale,
                width: WORD_W * scale,
                height: wordH,
              },
            ]}>
            {LETTER_STRIPS.map((s, i) => (
              <Animated.View
                key={i}
                style={[
                  styles.abs,
                  {
                    left: s.x0 * PIXEL_W * scale,
                    top: 0,
                    width: (s.x1 - s.x0) * PIXEL_W * scale,
                    height: wordH,
                    opacity: strokes[i],
                  },
                ]}>
                <ToneLayer
                  tones={s.tones}
                  fill={base}
                  view={[s.x0 * PIXEL_W, 0, (s.x1 - s.x0) * PIXEL_W, WORD_H]}
                  width={(s.x1 - s.x0) * PIXEL_W * scale}
                  height={wordH}
                />
              </Animated.View>
            ))}

            {!reduce && (
              <View
                style={[styles.abs, {width: WORD_W * scale, height: wordH}]}
                pointerEvents="none">
                {strips()}
              </View>
            )}
          </View>
          <View style={[styles.abs, {width: W, height: rodH}]}>
            <ToneLayer
              tones={SCROLL.rod.tones}
              fill={base}
              view={[0, 0, LOGO_W, ROD_H]}
              width={W}
              height={rodH}
            />
          </View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  abs: {position: 'absolute', top: 0, left: 0},
});
