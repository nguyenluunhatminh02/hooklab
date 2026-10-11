import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WCAG color gate for the design tokens (BUILD_PLAN §5.3 / design 04 §9).
 *
 * jsdom cannot resolve OKLCH into rendered pixels, so the `color-contrast` axe
 * rule is disabled in the component specs — this spec is the compensation. It
 * reads the real tokens.css and computes the WCAG 2.x contrast ratios with the
 * same OKLCH -> OKLab -> linear sRGB -> sRGB -> relative luminance pipeline a
 * browser applies.
 */

interface Oklch {
  l: number;
  c: number;
  h: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface ContrastRequirement {
  label: string;
  foreground: Oklch;
  background: Oklch;
  minimum: number;
}

// Bind import.meta.url to a variable first: Vite's asset pipeline rewrites the
// literal `new URL('./x', import.meta.url)` pattern into a dev-server http URL,
// which node:fs rejects. The bound form keeps the file:// source-of-truth path.
const MODULE_URL = import.meta.url;
const TOKENS_URL = new URL('./tokens.css', MODULE_URL);
const INDEX_HTML_URL = new URL('../../index.html', MODULE_URL);

const TOKENS_SOURCE = readFileSync(TOKENS_URL, 'utf8');

const GAMMA_LINEAR_THRESHOLD = 0.0031308;
const CHANNEL_MAX = 255;
const AA_BODY_TEXT_RATIO = 4.5;
const AA_UI_COMPONENT_RATIO = 3;
const MIN_HUE_SEPARATION_DEGREES = 20;

function readToken(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(TOKENS_SOURCE);
  if (match === null) {
    throw new Error(`tokens.css does not define --${name}`);
  }
  return match[1].trim();
}

/** Parses `oklch(L C H)`, tolerating a `deg` hue suffix and ignoring alpha. */
function parseOklch(value: string): Oklch {
  const match =
    /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:deg)?\s*(?:\/\s*[0-9.]+%?\s*)?\)$/.exec(value);
  if (match === null) {
    throw new Error(`Unparseable OKLCH value: "${value}"`);
  }
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

function oklchToLinearSrgb(color: Oklch): Rgb {
  const hueRadians = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hueRadians);
  const b = color.c * Math.sin(hueRadians);

  const l = (color.l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (color.l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (color.l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function clamp01(channel: number): number {
  return Math.min(1, Math.max(0, channel));
}

function linearToSrgb(channel: number): number {
  const clamped = clamp01(channel);
  return clamped <= GAMMA_LINEAR_THRESHOLD
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function srgbToLinear(channel: number): number {
  const clamped = clamp01(channel);
  return clamped <= 0.04045 ? clamped / 12.92 : ((clamped + 0.055) / 1.055) ** 2.4;
}

function toSrgb(color: Oklch): Rgb {
  const linear = oklchToLinearSrgb(color);
  return {
    r: linearToSrgb(linear.r),
    g: linearToSrgb(linear.g),
    b: linearToSrgb(linear.b),
  };
}

function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * srgbToLinear(color.r) +
    0.7152 * srgbToLinear(color.g) +
    0.0722 * srgbToLinear(color.b)
  );
}

function contrastRatio(first: Oklch, second: Oklch): number {
  const firstLuminance = relativeLuminance(toSrgb(first));
  const secondLuminance = relativeLuminance(toSrgb(second));
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function toChannel255(channel: number): number {
  return clamp01(channel) * CHANNEL_MAX;
}

function toHex(color: Rgb): string {
  const digits = [color.r, color.g, color.b]
    .map((channel) => Math.round(toChannel255(channel)).toString(16).padStart(2, '0'))
    .join('');
  return `#${digits}`;
}

function hueSeparationDegrees(first: Oklch, second: Oklch): number {
  const rawDelta = Math.abs(first.h - second.h) % 360;
  return Math.min(rawDelta, 360 - rawDelta);
}

function firstFontFamily(stack: string): string {
  const [first = ''] = stack.split(',');
  return first.trim().replace(/^['"]|['"]$/g, '');
}

const BG = parseOklch(readToken('color-bg'));
const SURFACE = parseOklch(readToken('color-surface'));
const TEXT = parseOklch(readToken('color-text'));
const TEXT_MUTED = parseOklch(readToken('color-text-muted'));
const PRIMARY = parseOklch(readToken('color-primary'));
const ACCENT = parseOklch(readToken('color-accent'));

const CONTRAST_REQUIREMENTS: readonly ContrastRequirement[] = [
  {
    label: '--color-text on --color-bg',
    foreground: TEXT,
    background: BG,
    minimum: AA_BODY_TEXT_RATIO,
  },
  {
    label: '--color-text-muted on --color-bg',
    foreground: TEXT_MUTED,
    background: BG,
    minimum: AA_BODY_TEXT_RATIO,
  },
  {
    label: '--color-text on --color-surface',
    foreground: TEXT,
    background: SURFACE,
    minimum: AA_BODY_TEXT_RATIO,
  },
  {
    label: '--color-text-muted on --color-surface',
    foreground: TEXT_MUTED,
    background: SURFACE,
    minimum: AA_BODY_TEXT_RATIO,
  },
  {
    label: '--color-primary on --color-bg',
    foreground: PRIMARY,
    background: BG,
    minimum: AA_UI_COMPONENT_RATIO,
  },
  {
    label: '--color-accent on --color-bg',
    foreground: ACCENT,
    background: BG,
    minimum: AA_UI_COMPONENT_RATIO,
  },
];

describe('design tokens', () => {
  it('calibrates the OKLCH to contrast pipeline against known anchors', () => {
    const whiteOnBlack = contrastRatio(parseOklch('oklch(1 0 0)'), parseOklch('oklch(0 0 0)'));
    expect(
      Math.abs(whiteOnBlack - 21),
      `white on black measured ${whiteOnBlack.toFixed(4)}:1, expected 21 +/- 0.1`,
    ).toBeLessThanOrEqual(0.1);

    const red = toSrgb(parseOklch('oklch(0.6280 0.2577 29.2)'));
    const redHex = toHex(red);
    const expectedChannels = [255, 0, 0];
    const measuredChannels = [toChannel255(red.r), toChannel255(red.g), toChannel255(red.b)];
    measuredChannels.forEach((channel, index) => {
      expect(
        Math.abs(channel - expectedChannels[index]),
        `sRGB red round-trip ${redHex}: channel ${index} measured ${channel.toFixed(3)}, expected ${expectedChannels[index]} within one 8-bit step`,
      ).toBeLessThanOrEqual(1);
    });
  });

  it('meets WCAG AA contrast thresholds for text, muted text, primary and accent', () => {
    for (const requirement of CONTRAST_REQUIREMENTS) {
      const ratio = contrastRatio(requirement.foreground, requirement.background);
      expect(
        ratio,
        `${requirement.label} measured ${ratio.toFixed(3)}:1, required ${requirement.minimum}:1`,
      ).toBeGreaterThanOrEqual(requirement.minimum);
    }
  });

  it('separates the primary and accent hues by at least 20 degrees in OKLCH', () => {
    const separation = hueSeparationDegrees(PRIMARY, ACCENT);
    expect(
      separation,
      `--color-primary hue ${PRIMARY.h} vs --color-accent hue ${ACCENT.h}: measured ${separation.toFixed(1)}deg separation, required >= ${MIN_HUE_SEPARATION_DEGREES}deg`,
    ).toBeGreaterThanOrEqual(MIN_HUE_SEPARATION_DEGREES);
  });

  it('keeps IBM Plex Sans and IBM Plex Mono as the first families of the font stacks', () => {
    const sansFirst = firstFontFamily(readToken('font-sans'));
    const monoFirst = firstFontFamily(readToken('font-mono'));

    expect(sansFirst, `--font-sans first family measured "${sansFirst}"`).toBe('IBM Plex Sans');
    expect(monoFirst, `--font-mono first family measured "${monoFirst}"`).toBe('IBM Plex Mono');

    const indexHtml = readFileSync(INDEX_HTML_URL, 'utf8');
    expect(
      indexHtml.includes('family=IBM+Plex+Sans'),
      'index.html must request the IBM Plex Sans family from Google Fonts',
    ).toBe(true);
    expect(
      indexHtml.includes('family=IBM+Plex+Mono'),
      'index.html must request the IBM Plex Mono family from Google Fonts',
    ).toBe(true);
  });
});
