import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Shell-level a11y contracts: index.html metadata and the global stylesheets.
// No component test can reach these — they are static files, so read them from
// disk relative to this spec instead of through the vite/jsdom pipeline.

// Bind the module URL before resolving: Vite's asset transform rewrites the
// literal `new URL(..., import.meta.url)` pattern to a dev-server URL, which
// node:fs cannot open.
const specUrl = import.meta.url;
const shellHtml = readFileSync(new URL('../../index.html', specUrl), 'utf8');
const globalCss = readFileSync(new URL('../styles/global.css', specUrl), 'utf8');
const tokensCss = readFileSync(new URL('../styles/tokens.css', specUrl), 'utf8');

function linkTags(): string[] {
  return shellHtml.match(/<link\b[^>]*>/g) ?? [];
}

/** First family of a `--variable: 'Family One', fallback;` declaration. */
function firstFontFamily(variableName: string): string {
  const declaration = tokensCss.match(new RegExp(`--${variableName}\\s*:\\s*([^;]+);`))?.[1] ?? '';
  const firstFamily = declaration.split(',')[0];
  return firstFamily.trim().replace(/^['"]|['"]$/g, '');
}

/** Body of a CSS rule/media block found by opener text; '' when absent. */
function blockBody(source: string, opener: string): string {
  const openerIndex = source.indexOf(opener);
  if (openerIndex === -1) return '';
  const bodyIndex = source.indexOf('{', openerIndex);
  if (bodyIndex === -1) return '';
  let depth = 0;
  for (let index = bodyIndex; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyIndex + 1, index);
    }
  }
  return '';
}

describe('index.html', () => {
  it('declares English as the document language', () => {
    expect(shellHtml).toMatch(/<html[^>]*\slang="en"[^>]*>/);
  });

  it('pins the desktop-class viewport meta', () => {
    const viewportTag = shellHtml.match(/<meta[^>]*\sname="viewport"[^>]*>/)?.[0] ?? '';
    expect(viewportTag).toContain('content="width=device-width, initial-scale=1.0"');
  });

  it('has a non-empty document title', () => {
    const title = shellHtml.match(/<title>([^<]+)<\/title>/)?.[1]?.trim() ?? '';
    expect(title).not.toBe('');
  });

  it('exposes exactly one #root mount node', () => {
    const rootMounts = shellHtml.match(/<div\b[^>]*\sid="root"[^>]*>/g) ?? [];
    expect(rootMounts).toHaveLength(1);
  });

  it('loads the React entry as a module script from /src/main.tsx', () => {
    const entryScript = shellHtml.match(/<script\b[^>]*\ssrc="\/src\/main\.tsx"[^>]*>/)?.[0] ?? '';
    expect(entryScript).not.toBe('');
    expect(entryScript).toContain('type="module"');
  });

  it('preconnects to both Google Fonts origins, gstatic with CORS', () => {
    const preconnectTags = linkTags().filter((tag) => tag.includes('rel="preconnect"'));
    const googleapisTag = preconnectTags.find((tag) => tag.includes('fonts.googleapis.com')) ?? '';
    const gstaticTag = preconnectTags.find((tag) => tag.includes('fonts.gstatic.com')) ?? '';
    expect(googleapisTag).toContain('href="https://fonts.googleapis.com"');
    expect(gstaticTag).toContain('href="https://fonts.gstatic.com"');
    expect(gstaticTag).toContain('crossorigin');
  });

  it('loads IBM Plex Mono and IBM Plex Sans, matching the token families', () => {
    const stylesheetTag = linkTags().find((tag) => tag.includes('rel="stylesheet"')) ?? '';
    expect(stylesheetTag).toContain('fonts.googleapis.com/css2');

    const sansFamily = firstFontFamily('font-sans');
    const monoFamily = firstFontFamily('font-mono');
    expect(sansFamily).toBe('IBM Plex Sans');
    expect(monoFamily).toBe('IBM Plex Mono');
    expect(stylesheetTag).toContain(`family=${sansFamily.replace(/ /g, '+')}`);
    expect(stylesheetTag).toContain(`family=${monoFamily.replace(/ /g, '+')}`);
  });
});

describe('global.css', () => {
  it('neutralises transitions and animations under prefers-reduced-motion', () => {
    const reduceMotionBlock = blockBody(globalCss, '@media (prefers-reduced-motion: reduce)');
    expect(reduceMotionBlock).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(reduceMotionBlock).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });

  it('keeps a visible keyboard focus outline driven by the primary token', () => {
    const focusBlock = blockBody(globalCss, ':focus-visible');
    expect(focusBlock).toMatch(/outline:\s*2px solid var\(--color-primary\)/);
    expect(focusBlock).toMatch(/outline-offset:\s*2px/);
    // An undefined custom property would make the whole outline declaration
    // invalid at computed-value time, i.e. no focus indicator at all.
    expect(tokensCss).toMatch(/--color-primary\s*:/);
  });
});
