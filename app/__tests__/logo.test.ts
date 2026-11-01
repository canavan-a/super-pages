import fs from 'fs';
import path from 'path';

import {describe, expect, it} from '@jest/globals';

import palette from '../src/logo/iconPalette.json';
import {LOGO} from '../src/logo/logoData';
import {
  hexToRgb,
  isLightTheme,
  shineColor,
  shineTarget,
  themeAccent,
  themeRamp,
  toneColor,
} from '../src/logo/logoTheme';
import {
  SPLASH_TIMING,
  SPLASH_TOTAL,
  curlRange,
  pulseRange,
  writeRange,
} from '../src/logo/SplashScreen';
import {CURL_REST, SCROLL} from '../src/logo/scroll';
import {
  LETTER_STRIPS,
  SHINE_STRIPS,
  STRIP_SPANS,
  WORD_STRIPS,
  WORD_TONES,
  sliceTones,
} from '../src/logo/LogoArt';
import {DEFAULT_ICON, wantedIcon} from '../src/appIcon';
import {THEME_OPTIONS, THEMES} from '../src/theme';

const close = (a: string, b: string, tol = 1) => {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return x.every((v, i) => Math.abs(v - y[i]) <= tol);
};

describe('logo colors agree with the generator (Go) and with theme.tsx', () => {
  it('has a palette for every app theme and no others', () => {
    expect(Object.keys(palette.themes).sort()).toEqual(
      THEME_OPTIONS.map(o => o.name).sort(),
    );
  });

  for (const {name} of THEME_OPTIONS) {
    it(`${name}: ramp, accent and icon tones match`, () => {
      const theme = THEMES[name];
      const p = (palette.themes as Record<string, any>)[name];
      expect(p.bg).toBe(theme.bg);
      themeRamp(theme).forEach((c, i) => {
        const hex =
          '#' +
          c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
        expect(close(hex, p.ramp[i])).toBe(true);
      });
      const acc = themeAccent(theme);
      expect(
        close(
          '#' +
            acc.map(v => Math.round(v).toString(16).padStart(2, '0')).join(''),
          p.accent,
        ),
      ).toBe(true);
      expect(p.iconTones.length).toBeGreaterThanOrEqual(1);
      for (const t of p.iconTones) {
        const mine = toneColor(theme, t.u, t.w);
        expect({name, u: t.u, w: t.w, ok: close(mine, t.color)}).toEqual({
          name,
          u: t.u,
          w: t.w,
          ok: true,
        });
      }
    });
  }

  it('maps the art page to the theme page, and its strokes to the text color', () => {
    for (const {name} of THEME_OPTIONS) {
      const t = THEMES[name];
      expect(toneColor(t, 0, 0)).toBe(t.bg.toLowerCase());
      expect(close(toneColor(t, 4, 0), t.text)).toBe(true);
    }
  });

  it('shines toward white on dark themes and toward black on light ones', () => {
    for (const {name} of THEME_OPTIONS) {
      const t = THEMES[name];
      expect(shineTarget(t)).toBe(isLightTheme(t) ? '#000000' : '#ffffff');
      const base = toneColor(t, 3, 0);
      const lit = shineColor(base, t, 0.5);
      const lumOf = (h: string) =>
        hexToRgb(h).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      expect(
        isLightTheme(t) ? lumOf(lit) < lumOf(base) : lumOf(lit) > lumOf(base),
      ).toBe(true);
    }
    expect(isLightTheme(THEMES.light)).toBe(true);
    expect(isLightTheme(THEMES.sepia)).toBe(true);
    expect(isLightTheme(THEMES.dark)).toBe(false);
    expect(isLightTheme(THEMES.ember)).toBe(false);
  });
});

describe('logo data', () => {
  const every = (
    tones: {u: number; w: number; runs: number[]}[],
    rows: number,
    fn: (x: number, y: number, len: number) => void,
  ) => {
    for (const t of tones) {
      expect(t.u).toBeGreaterThanOrEqual(0);
      expect(t.u).toBeLessThanOrEqual(4);
      expect(t.w).toBeGreaterThanOrEqual(0);
      expect(t.w).toBeLessThanOrEqual(1);
      expect(t.runs.length % 3).toBe(0);
      for (let i = 0; i < t.runs.length; i += 3) {
        const [x, y, len] = [t.runs[i], t.runs[i + 1], t.runs[i + 2]];
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(rows);
        expect(len).toBeGreaterThan(0);
        fn(x, y, len);
      }
    }
  };

  it('keeps every run inside the picture', () => {
    const inside = (x: number, _y: number, len: number) => {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + len).toBeLessThanOrEqual(LOGO.width);
    };
    every(LOGO.mark.tones, LOGO.mark.rows, inside);
    for (const s of LOGO.word.slices) every(s.tones, LOGO.word.rows, inside);
    every(LOGO.icon.tones, LOGO.icon.h, (x, _y, len) => {
      expect(x + len).toBeLessThanOrEqual(LOGO.icon.w);
    });
  });

  it('cuts the stacked wordmark into 10 slices (S-u-p-e-r over P-a-g-e-s), contiguous per line, each holding only its own columns', () => {
    expect(LOGO.word.slices).toHaveLength(10);
    const firstRow = (s: (typeof LOGO.word.slices)[number]) =>
      Math.min(...s.tones.flatMap(t => t.runs.filter((_, k) => k % 3 === 1)));
    LOGO.word.slices.forEach((s, i) => {
      expect(s.x1).toBeGreaterThan(s.x0);
      // "Pages" starts a new line at slice 5, below all of "Super".
      if (i > 0 && i !== 5) expect(s.x0).toBe(LOGO.word.slices[i - 1].x1);
      if (i >= 5)
        expect(firstRow(s)).toBeGreaterThan(
          Math.max(...LOGO.word.slices.slice(0, 5).map(firstRow)),
        );
      for (const t of s.tones) {
        for (let k = 0; k < t.runs.length; k += 3) {
          expect(t.runs[k]).toBeGreaterThanOrEqual(s.x0);
          expect(t.runs[k] + t.runs[k + 2]).toBeLessThanOrEqual(s.x1);
        }
      }
    });
  });

  it('uses the whole scroll for the icon', () => {
    expect(LOGO.icon.w).toBe(42);
    expect(LOGO.icon.h).toBeGreaterThanOrEqual(30);
    expect(LOGO.icon.h).toBeLessThanOrEqual(LOGO.mark.rows);
  });
});

describe('shine strips', () => {
  const inkOf = (tones: {runs: number[]}[]) =>
    tones.reduce(
      (n, t) =>
        n + t.runs.filter((_, i) => i % 3 === 2).reduce((a, b) => a + b, 0),
      0,
    );

  it("tile the logo's width exactly, with no gaps or overlaps", () => {
    expect(STRIP_SPANS).toHaveLength(SHINE_STRIPS);
    expect(STRIP_SPANS[0].x0).toBe(0);
    expect(STRIP_SPANS[SHINE_STRIPS - 1].x1).toBe(LOGO.width);
    STRIP_SPANS.forEach((s, i) => {
      expect(s.x1).toBeGreaterThan(s.x0);
      if (i > 0) expect(s.x0).toBe(STRIP_SPANS[i - 1].x1);
    });
  });

  it("together hold exactly the wordmark's pixels (nothing lost, nothing doubled)", () => {
    const word = inkOf(WORD_TONES);
    expect(inkOf(WORD_STRIPS.flatMap(s => s.tones))).toBe(word);
    // and each strip's runs stay inside its own columns
    for (const s of WORD_STRIPS) {
      for (const t of s.tones) {
        for (let i = 0; i < t.runs.length; i += 3) {
          expect(t.runs[i]).toBeGreaterThanOrEqual(s.x0);
          expect(t.runs[i] + t.runs[i + 2]).toBeLessThanOrEqual(s.x1);
        }
      }
    }
  });

  it('sliceTones clips runs at the edges and drops tones that end up empty', () => {
    const tones = [{u: 1, w: 0, runs: [0, 0, 10, 20, 1, 5]}];
    expect(sliceTones(tones, 5, 8)).toEqual([{u: 1, w: 0, runs: [5, 0, 3]}]);
    expect(sliceTones(tones, 12, 18)).toEqual([]);
    expect(sliceTones(tones, 22, 30)).toEqual([{u: 1, w: 0, runs: [22, 1, 3]}]);
  });

  it('fade in and out over a valid, strictly increasing range, for every strip', () => {
    for (const lag of [0, 0.05]) {
      for (let i = 0; i < SHINE_STRIPS; i++) {
        const [a, b, c] = pulseRange(i, SHINE_STRIPS, lag);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
        expect(a).toBeLessThan(b); // an interpolation's input range must strictly increase
        expect(b).toBeLessThan(c);
      }
    }
  });

  it('sweep left to right', () => {
    let last = -1;
    for (let i = 0; i < SHINE_STRIPS; i++) {
      const [, c] = pulseRange(i, SHINE_STRIPS, 0);
      expect(c).toBeGreaterThan(last);
      last = c;
    }
  });
});

describe('the hanging sheet', () => {
  const at = (r: {input: number[]; output: number[]}, p: number) => {
    const {input: x, output: y} = r;
    if (p <= x[0]) return y[0];
    for (let i = 1; i < x.length; i++)
      if (p <= x[i])
        return (
          y[i - 1] + ((y[i] - y[i - 1]) * (p - x[i - 1])) / (x[i] - x[i - 1])
        );
    return y[y.length - 1];
  };
  const sizes = Array.from({length: CURL_REST}, (_, i) => i + 1);

  it('springs its curl through valid, strictly increasing ranges', () => {
    for (const k of sizes) {
      const {input} = curlRange(k);
      expect(input[0]).toBeGreaterThanOrEqual(0);
      expect(input[input.length - 1]).toBeLessThanOrEqual(1);
      for (let i = 1; i < input.length; i++)
        expect(input[i]).toBeGreaterThan(input[i - 1]);
    }
  });

  it('shows one curl at a time: at rest, flattening to one row, and back', () => {
    const shown = (p: number) => sizes.filter(k => at(curlRange(k), p) > 0.5);
    expect(shown(0)).toEqual([CURL_REST]);
    expect(shown(0.5)).toEqual([1]);
    expect(shown(1)).toEqual([CURL_REST]);
    for (let p = 0; p <= 1; p += 0.01) expect(shown(p)).toHaveLength(1);
  });

  it('has every curl size drawn, growing with its size', () => {
    let last = 0;
    for (const k of sizes) {
      const n = SCROLL.curls[k].reduce((a, t) => a + t.runs.length / 3, 0);
      expect(n).toBeGreaterThan(last);
      last = n;
    }
  });

  it('writes each letter left to right, the letters in order', () => {
    const last = new Map<number, number>();
    let firstOfLast = -1;
    for (const st of LETTER_STRIPS) {
      const [a, b] = writeRange(st);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      expect(a).toBeLessThan(b);
      if (last.has(st.letter)) expect(a).toBeGreaterThan(last.get(st.letter)!);
      else {
        // a new letter starts after the one before it did
        expect(a).toBeGreaterThan(firstOfLast);
        firstOfLast = a;
      }
      last.set(st.letter, a);
    }
  });

  it("writes exactly the wordmark's pixels", () => {
    const ink = (tones: {runs: number[]}[]) =>
      tones.reduce(
        (n, t) =>
          n + t.runs.filter((_, i) => i % 3 === 2).reduce((a, b) => a + b, 0),
        0,
      );
    expect(ink(LETTER_STRIPS.flatMap(s => s.tones))).toBe(ink(WORD_TONES));
  });
});

describe('splash timeline', () => {
  const T = SPLASH_TIMING;
  it('brings the letters in before the shine starts, and the shine finishes before the exit', () => {
    const lettersDone =
      T.letterStart +
      (LOGO.word.slices.length - 1) * T.letterStagger +
      T.letterDur;
    expect(lettersDone).toBeLessThanOrEqual(T.shineStart);
    expect(T.unrollStart + T.unrollDur).toBeLessThanOrEqual(T.curlStart + 100);
    expect(T.curlStart + T.curlDur).toBeLessThanOrEqual(T.letterStart);
    expect(T.shineStart + T.shineDur).toBeLessThanOrEqual(T.hold);
  });
  it('is short enough not to be annoying', () => {
    expect(SPLASH_TOTAL).toBeLessThanOrEqual(3000);
    expect(SPLASH_TOTAL).toBe(T.hold + T.exit);
  });
});

describe('launcher icon', () => {
  it('follows the theme, or stays on the default when switched off', () => {
    expect(wantedIcon('ember', true)).toBe('ember');
    expect(wantedIcon('ember', false)).toBe(DEFAULT_ICON);
  });

  const res = path.join(__dirname, '../android/app/src/main/res');
  const manifest = fs.readFileSync(
    path.join(__dirname, '../android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );

  it('declares exactly one launcher alias per theme, with only the default enabled', () => {
    const aliases =
      manifest.match(/<activity-alias[\s\S]*?<\/activity-alias>/g) ?? [];
    expect(aliases).toHaveLength(THEME_OPTIONS.length);
    const enabled: string[] = [];
    for (const {name} of THEME_OPTIONS) {
      const cap = name[0].toUpperCase() + name.slice(1);
      const a = aliases.find(x => x.includes(`android:name=".Icon${cap}"`));
      expect(a).toBeDefined();
      expect(a).toContain('android.intent.category.LAUNCHER');
      expect(a).toContain(`@mipmap/ic_launcher_${name}"`);
      expect(a).toContain(`@mipmap/ic_launcher_${name}_round"`);
      if (a!.includes('android:enabled="true"')) enabled.push(name);
    }
    expect(enabled).toEqual([DEFAULT_ICON]);
  });

  it('no longer launches MainActivity directly (only through the aliases)', () => {
    const activity = manifest.match(
      /<activity\b[\s\S]*?(\/>|<\/activity>)/,
    )![0];
    expect(activity).not.toContain('LAUNCHER');
  });

  it('ships every icon: adaptive XML + vector, and legacy PNGs at every density', () => {
    for (const {name} of THEME_OPTIONS) {
      for (const suffix of ['', '_round']) {
        expect(
          fs.existsSync(
            path.join(
              res,
              `mipmap-anydpi-v26/ic_launcher_${name}${suffix}.xml`,
            ),
          ),
        ).toBe(true);
        for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
          expect(
            fs.existsSync(
              path.join(res, `mipmap-${d}/ic_launcher_${name}${suffix}.png`),
            ),
          ).toBe(true);
        }
      }
      expect(
        fs.existsSync(path.join(res, `drawable/ic_launcher_fg_${name}.xml`)),
      ).toBe(true);
    }
    expect(fs.existsSync(path.join(res, 'drawable/ic_launcher_mono.xml'))).toBe(
      true,
    );
  });

  it("uses each theme's real page color as its icon background", () => {
    const colors = fs.readFileSync(
      path.join(res, 'values/ic_theme_icons.xml'),
      'utf8',
    );
    for (const {name} of THEME_OPTIONS) {
      const m = colors.match(
        new RegExp(`name="ic_bg_${name}">(#[0-9a-fA-F]{6})<`),
      );
      expect(m).not.toBeNull();
      expect(m![1].toLowerCase()).toBe(THEMES[name].bg.toLowerCase());
    }
  });

  it('has the native module registered', () => {
    const app = fs.readFileSync(
      path.join(
        __dirname,
        '../android/app/src/main/java/com/superpagesapp/MainApplication.kt',
      ),
      'utf8',
    );
    expect(app).toContain('AppIconPackage()');
  });
});
