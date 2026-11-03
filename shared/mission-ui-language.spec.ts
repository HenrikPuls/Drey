/**
 * Language guard (CLAUDE.md, "Language Convention"): everything the
 * Mission Control UI displays is English. The sources of the shared lib
 * and of the app are scanned for German — any umlaut or ß, and a short
 * list of unmistakably German function and UI words. The machine-format
 * `## Verlauf` keys (`dauer`, `ausgang`) are file format, lowercase and
 * not on the list. The spec lives under `shared/` because the lib's
 * Angular test runner has no Node types.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['libs/mission-ui/src', 'apps/mission-control/src'];
const UMLAUT = /[äöüßÄÖÜ]/;
const GERMAN_WORDS =
  /\b(und|oder|nicht|nichts|eine|einen|wird|werden|für|Datei|Sitzung|Antwort|Zurück|Nachricht|Schließen|Senden|Verwerfen|Bestätig\w*|Neuer|Neues|Anhang|Arbeit|Gerät|Kette|jetzt|noch|keine|läuft|aktiv|warten|Karten)\b/;

function sourcesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourcesUnder(path, out);
    } else if (/\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('the UI language is English', () => {
  const files = ROOTS.flatMap((root) => sourcesUnder(join(process.cwd(), root)));

  it('finds the sources it guards', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('carries no umlaut or ß in any source', () => {
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ file, line: i + 1, text: line }))
        .filter((l) => UMLAUT.test(l.text))
        .map((l) => `${l.file}:${l.line}: ${l.text.trim().slice(0, 80)}`),
    );
    expect(hits).toEqual([]);
  });

  it('carries no German UI word in any source', () => {
    const hits = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ file, line: i + 1, text: line }))
        .filter((l) => GERMAN_WORDS.test(l.text))
        .map((l) => `${l.file}:${l.line}: ${l.text.trim().slice(0, 80)}`),
    );
    expect(hits).toEqual([]);
  });
});
