/**
 * Design-scale guard (E12-7, canvas decision 2026-11-04, Anthrazit tokens):
 * the tickets plugin's stylesheets and Mission Control (the `@mission-ui`
 * lib and the app) use the three-step radius scale (chip 4 / control 8 /
 * dialog 16, as CSS tokens), no font-size below the type floor (13 px on
 * Mission Control; 12 px on the desktop tickets surfaces, where only dense
 * list metadata goes that low) and the Anthrazit attention pastels exist
 * in the token blocks. Other Drey panels keep the legacy radius steps and
 * are deliberately not scanned. Lives under `shared/` for the Node runner.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function cssUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      cssUnder(path, out);
    } else if (name.endsWith('.css')) {
      out.push(path);
    }
  }
  return out;
}

const MC_FILES = [...cssUnder('libs/mission-ui/src'), ...cssUnder('apps/mission-control/src')];
const TICKETS_FILES = cssUnder('plugins/tickets/renderer');

const ALLOWED_RADIUS = /^(0|50%|inherit|9{2,3}px|var\(--radius-(chip|control|dialog)\))$/;

function radiusViolations(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const css = readFileSync(file, 'utf8');
    for (const m of css.matchAll(/(?<![\w-])border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;}]+)/g)) {
      const parts = m[1]!.trim().split(/\s+(?![^()]*\))/);
      if (!parts.every((p) => ALLOWED_RADIUS.test(p))) {
        out.push(`${file}: ${m[0]}`);
      }
    }
  }
  return out;
}

function fontViolations(files: string[], floorPx: number): string[] {
  const out: string[] = [];
  for (const file of files) {
    const css = readFileSync(file, 'utf8');
    for (const m of css.matchAll(/font-size\s*:\s*(?:calc\()?(\d*\.?\d+)(px|rem)/g)) {
      const px = m[2] === 'rem' ? parseFloat(m[1]!) * 16 : parseFloat(m[1]!);
      if (px < floorPx) {
        out.push(`${file}: ${m[0]}`);
      }
    }
  }
  return out;
}

describe('the Anthrazit design scales', () => {
  it('Mission Control and the tickets plugin use only the 4 / 8 / 16 radius tokens', () => {
    expect(radiusViolations([...MC_FILES, ...TICKETS_FILES])).toEqual([]);
  });

  it('Mission Control has no font-size below 13 px', () => {
    expect(fontViolations(MC_FILES, 13)).toEqual([]);
  });

  it('the desktop tickets surfaces have no font-size below 12 px', () => {
    expect(fontViolations(TICKETS_FILES, 12)).toEqual([]);
  });

  it('defines the radius scale and the attention pastels in both token sheets', () => {
    for (const sheet of ['src/styles.css', 'apps/mission-control/src/styles.css']) {
      const css = readFileSync(sheet, 'utf8');
      expect(css).toMatch(/--radius-chip:\s*4px/);
      expect(css).toMatch(/--radius-control:\s*8px/);
      expect(css).toMatch(/--radius-dialog:\s*16px/);
      expect(css).toMatch(/--accent-peach:\s*#f2cfae/);
      expect(css).toMatch(/--accent-pink:\s*#f2d3e2/);
      expect(css).toMatch(/--accent-mint:\s*#bfe3cd/);
    }
  });
});
