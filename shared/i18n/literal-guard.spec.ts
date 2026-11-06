import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogKeys } from './catalog';
import guarded from './guarded-paths.json';
import { findLiteralStrings, findTemplateStrings, looksLikeText, optsIn } from './literal-guard';

/**
 * The literal-string guard (ADR-0091): first the detector on small
 * sources, then the repo scan — every `.ts` / `.html` under a guarded path
 * (and every file carrying the opt-in marker under the same roots) holds
 * no user-visible literal and names no key the catalog lacks.
 */
describe('looksLikeText', () => {
  it('reads a capitalised word or two letter words as text', () => {
    for (const text of ['Accept', 'Paused', 'Ready to try', 'in total', 'no estimate yet (first run)', 'Resume at']) {
      expect(looksLikeText(text), text).toBe(true);
    }
  });

  it('reads code-shaped literals as code', () => {
    for (const text of [
      'autopilot.state.on',
      'cost.so_far',
      'mc-app-bar',
      'seg seg-on',
      'flex items-center gap-2',
      'McState',
      'SCREAMING_CASE',
      './x.html',
      'https://example.test/a',
      '1px solid',
      'px',
      'en',
      '#fff',
      '',
      ' ',
    ]) {
      expect(looksLikeText(text), text).toBe(false);
    }
  });
});

describe('findLiteralStrings (TypeScript)', () => {
  it('flags text literals where a user could see them', () => {
    const source = [
      `const label = 'Ready to try';`,
      `el.textContent = "Accept";`,
      'button.title = `Stop now`;',
    ].join('\n');
    expect(findLiteralStrings(source).map((f) => [f.line, f.text, f.reason])).toEqual([
      [1, 'Ready to try', 'text'],
      [2, 'Accept', 'text'],
      [3, 'Stop now', 'text'],
    ]);
  });

  it('passes the ordinary non-text literals of a component', () => {
    const source = [
      `import { Component } from '@angular/core';`,
      `import { Thing } from './thing';`,
      `@Component({ selector: 'mc-autopilot', templateUrl: './autopilot.html', styleUrl: './autopilot.css' })`,
      `class A { readonly cls = 'row row-on'; }`,
      `const o = { 'Spaced Key': 1, kind: 'card' };`,
      `const v = o['Spaced Key'];`,
      `switch (x) { case 'Ready to try': break; }`,
      `if (s === 'Paused' || s !== 'Off') {}`,
      `console.warn('Something went wrong here');`,
      `type T = 'Paused' | 'Off';`,
      `enum E { A = 'Alpha' }`,
    ].join('\n');
    expect(findLiteralStrings(source)).toEqual([]);
  });

  it('treats the first argument of t() / lookup() / has() as a key and checks it against the catalog', () => {
    const known = new Set(['autopilot.state.on']);
    const source = [
      `const a = i18n.t('autopilot.state.on');`,
      `const b = t('autopilot.state.onn');`,
      `const c = api.i18n.lookup('state.' + id);`,
      `const d = this.i18n.t('autopilot.state.on', { time: 'Resume now' });`,
    ].join('\n');
    expect(findLiteralStrings(source, 'x.ts', known).map((f) => [f.line, f.text, f.reason])).toEqual([
      [2, 'autopilot.state.onn', 'unknown-key'],
      [4, 'Resume now', 'text'],
    ]);
    // Without the catalog the keys are simply not text.
    expect(findLiteralStrings(source)).toEqual([{ line: 4, text: 'Resume now', reason: 'text' }]);
  });

  it('exempts a line marked i18n-ignore, on the same or the preceding line', () => {
    const source = [
      `const brand = 'Drey Crew'; // i18n-ignore: the product name`,
      `// i18n-ignore -- a mono id the owner wants verbatim`,
      `const id = 'Ticket Id';`,
      `const other = 'Not exempt';`,
    ].join('\n');
    expect(findLiteralStrings(source).map((f) => f.text)).toEqual(['Not exempt']);
  });
});

describe('findTemplateStrings (Angular templates)', () => {
  it('flags text nodes and plain text attributes, not bindings or interpolations', () => {
    const source = [
      `<button title="Stop all" [attr.aria-label]="label()">`,
      `  Accept`,
      `</button>`,
      `<span>{{ 'autopilot.title' | t }}</span>`,
      `<input placeholder="Search notes" />`,
      `<img [alt]="alt()" src="x.png" class="icon icon-lg" />`,
      `@if (open()) { <p>{{ count() }}</p> } @else { <p>None yet</p> }`,
      `<!-- Inbox -->`,
    ].join('\n');
    expect(findTemplateStrings(source).map((f) => [f.line, f.text])).toEqual([
      [1, 'Stop all'],
      [2, 'Accept'],
      [5, 'Search notes'],
      [7, 'None yet'],
    ]);
  });

  it('checks the key of a t pipe against the catalog and honours i18n-ignore', () => {
    const known = new Set(['autopilot.title']);
    const source = [
      `<span>{{ 'autopilot.title' | t }}</span>`,
      `<span>{{ 'autopilot.titel' | t }}</span>`,
      `<!-- i18n-ignore --><b>Drey</b>`,
    ].join('\n');
    expect(findTemplateStrings(source, known).map((f) => [f.line, f.text, f.reason])).toEqual([
      [2, 'autopilot.titel', 'unknown-key'],
    ]);
  });
});

describe('optsIn', () => {
  it('recognises the marker in the first lines only', () => {
    expect(optsIn('// i18n: catalog\nexport const a = 1;')).toBe(true);
    expect(optsIn('/** doc */\n\n// i18n: catalog-only\n')).toBe(true);
    expect(optsIn(`${'\n'.repeat(10)}// i18n: catalog`)).toBe(false);
    expect(optsIn('const s = "i18n: catalog";')).toBe(false);
  });
});

/** Every `.ts` / `.html` source under `dir` (no specs, no `.d.ts`), repo-relative. */
function sourcesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) {
    return out;
  }
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') {
        sourcesUnder(path, out);
      }
    } else if (/\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

/** The roots an opted-in file may live under: the four UI-bearing parts. */
const OPT_IN_ROOTS = ['src', 'libs', 'apps', 'plugins', 'packages/tickets-engine/src'];

describe('the guarded surfaces carry no literal user-visible string', () => {
  const repo = process.cwd();
  const known = new Set<string>(catalogKeys());
  const guardedFiles = guarded.paths.flatMap((dir) => sourcesUnder(join(repo, dir)));
  const optedIn = OPT_IN_ROOTS.flatMap((root) => sourcesUnder(join(repo, root))).filter(
    (file) => !guardedFiles.includes(file) && optsIn(readFileSync(file, 'utf8')),
  );
  const files = [...guardedFiles, ...optedIn];

  it('lists guarded paths as repo-relative directories with forward slashes', () => {
    for (const dir of guarded.paths) {
      expect(dir, dir).toMatch(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/);
    }
    expect(new Set(guarded.paths).size).toBe(guarded.paths.length);
  });

  it('names every guarded path in the ADR', () => {
    const adr = readFileSync(join(repo, 'docs/09_architecture_decisions/0091-i18n-catalog-for-the-new-surfaces.md'), 'utf8');
    for (const dir of guarded.paths) {
      expect(adr, dir).toContain(`\`${dir}/\``);
    }
  });

  it('finds no text literal and no unknown key in any guarded or opted-in file', () => {
    const hits = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const findings = file.endsWith('.html') ? findTemplateStrings(source, known) : findLiteralStrings(source, file, known);
      return findings.map((f) => `${relative(repo, file).replaceAll('\\', '/')}:${f.line} [${f.reason}] ${f.text}`);
    });
    expect(hits).toEqual([]);
  });
});
