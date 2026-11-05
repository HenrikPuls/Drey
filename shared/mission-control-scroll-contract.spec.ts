/**
 * D-5 — the app frame never moves. The CSS contract that keeps the installed
 * PWA from rubber-banding on iOS: the document itself does not scroll, and
 * every scroll container is an island (overscroll-behavior contain), so a drag
 * at the end of a list never chains into the page. Read from the stylesheet
 * sources, because no browser engine can be asked "does iOS move this".
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const ROOTS = [join(ROOT, 'apps/mission-control/src'), join(ROOT, 'libs/mission-ui/src')];

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(full));
    else if (entry.name.endsWith('.css')) out.push(full);
  }
  return out;
}

interface Rule {
  file: string;
  selector: string;
  body: string;
}

function rules(file: string): Rule[] {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push({ file, selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
  }
  return found;
}

const ALL = ROOTS.flatMap(cssFiles).flatMap(rules);

/** Containers that scroll vertically (overflow / overflow-y auto or scroll). */
const SCROLLERS = ALL.filter((r) => /(^|[;\s])overflow(-y)?\s*:\s*(auto|scroll)/.test(r.body));

describe('scroll contract (D-5)', () => {
  it('finds the scroll containers it is meant to check', () => {
    expect(SCROLLERS.length).toBeGreaterThan(15);
  });

  it('html and body never scroll or rubber-band', () => {
    const base = rules(join(ROOT, 'apps/mission-control/src/styles.css'));
    const html = base.find((r) => r.selector.startsWith('html,') && r.selector.includes('body'));
    expect(html?.body).toMatch(/overflow\s*:\s*hidden/);
    expect(html?.body).toMatch(/overscroll-behavior\s*:\s*none/);
    const body = base.find((r) => r.selector === 'body' && /position\s*:\s*fixed/.test(r.body));
    expect(body?.body).toMatch(/top\s*:\s*0/);
  });

  it('D-7d: the body is the visible area, so the keyboard shrinks the bottom and nothing else', () => {
    const base = rules(join(ROOT, 'apps/mission-control/src/styles.css'));
    const body = base.find((r) => r.selector === 'body' && /position\s*:\s*fixed/.test(r.body));
    // Height and offset come from the visual viewport (viewport.ts); the transform
    // makes the body the containing block of every position:fixed layer.
    expect(body?.body).toMatch(/height\s*:\s*var\(--mc-vh,\s*100%\)/);
    expect(body?.body).toMatch(/transform\s*:\s*translateY\(var\(--mc-vv-top,\s*0px\)\)/);
  });

  it('D-7d: nothing is sized by the layout viewport (100vh/100dvh), which the keyboard does not shrink', () => {
    const sized = ALL.filter((r) => /(^|[;\s])(min-|max-)?height\s*:\s*100d?vh/.test(r.body)).map(
      (r) => `${r.file.replace(ROOT, '')}: ${r.selector}`,
    );
    // The pairing screen has no composer; every screen with one sits in the body.
    expect(sized.filter((entry) => !entry.includes('pairing'))).toEqual([]);
  });

  it('every scroll container contains its overscroll', () => {
    const missing = SCROLLERS.filter(
      (r) => !/overscroll-behavior(-[xy])?\s*:\s*(contain|none)/.test(r.body),
    ).map((r) => `${r.file.replace(ROOT, '')}: ${r.selector}`);
    expect(missing).toEqual([]);
  });

  it('D-5b: the shell is no scroller — .pane is the one scroller of the phone column, the bars stay put', () => {
    const app = rules(join(ROOT, 'apps/mission-control/src/app/app.css'));
    const shell = app.find((r) => r.selector === '.shell');
    expect(shell?.body).toMatch(/overflow\s*:\s*hidden/);
    expect(shell?.body).not.toMatch(/overflow-y\s*:\s*(auto|scroll)/);
    const pane = app.find((r) => r.selector === '.pane');
    expect(pane?.body).toMatch(/overflow-y\s*:\s*auto/);
  });

  it('D-5b: the touch guard and the viewport tracker are installed at boot', () => {
    const main = readFileSync(join(ROOT, 'apps/mission-control/src/main.ts'), 'utf8');
    expect(main).toContain('lockPageScroll(window)');
    expect(main).toContain('trackVisualViewport(window)');
  });

  it('D-5b: no text field is under 16 px, which would make iOS zoom the page on focus', () => {
    const base = rules(join(ROOT, 'apps/mission-control/src/styles.css'));
    const guard = base.find((r) => r.selector.includes('textarea') && /font-size\s*:\s*max\(16px,\s*1em\)\s*!important/.test(r.body));
    expect(guard?.selector).toMatch(/input/);
    expect(guard?.selector).toMatch(/select/);
    const html = base.find((r) => r.selector.startsWith('html,') && r.selector.includes('body'));
    expect(html?.body).toMatch(/touch-action\s*:\s*manipulation/);
  });

  it('the app host keeps its :host rule', () => {
    const app = rules(join(ROOT, 'apps/mission-control/src/app/app.css'));
    expect(app.some((r) => r.selector === ':host')).toBe(true);
    expect(app.some((r) => r.selector.includes('::host'))).toBe(false);
  });
});
