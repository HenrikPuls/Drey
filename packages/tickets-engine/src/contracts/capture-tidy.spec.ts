import { describe, expect, it } from 'vitest';
import { CAPTURE_TIDY_SYSTEM, captureTidyMessages, parseCaptureTidy, rawCaptureLogText } from './capture-tidy';

describe('captureTidyMessages (req-75 W5c)', () => {
  it('sends the system contract, then the raw text trimmed', () => {
    expect(captureTidyMessages('  Fix the palette race in CI\n')).toEqual([
      { role: 'system', content: CAPTURE_TIDY_SYSTEM },
      { role: 'user', content: 'Fix the palette race in CI' },
    ]);
  });

  it('carries the prompt rules the spec quotes', () => {
    expect(CAPTURE_TIDY_SYSTEM).toContain('Reply with one JSON object and nothing else');
    expect(CAPTURE_TIDY_SYSTEM).toContain('at most 70 characters');
    expect(CAPTURE_TIDY_SYSTEM).toContain('Keep the language of the text');
  });
});

describe('parseCaptureTidy (req-75 W5c)', () => {
  it('reads a plain JSON reply', () => {
    expect(parseCaptureTidy('{"title": "Fix the palette", "description": "The palette flickers."}', 'the palette flickers fix it')).toEqual({
      title: 'Fix the palette',
      description: 'The palette flickers.',
    });
  });

  it('reads a fenced JSON reply', () => {
    const reply = '```json\n{"title": "Fix the palette", "description": "The palette flickers."}\n```';
    expect(parseCaptureTidy(reply, 'raw')).toEqual({ title: 'Fix the palette', description: 'The palette flickers.' });
  });

  it('trims the fields and cuts a long title to 80 characters', () => {
    const long = 'x'.repeat(120);
    const parsed = parseCaptureTidy(`{"title": "  ${long}  ", "description": "  Words.  "}`, 'raw');
    expect(parsed).toEqual({ title: 'x'.repeat(80), description: 'Words.' });
  });

  it('falls back to the raw text when the description comes back empty', () => {
    expect(parseCaptureTidy('{"title": "Fix", "description": "  "}', '  the palette flickers at startup  ')).toEqual({
      title: 'Fix',
      description: 'the palette flickers at startup',
    });
  });

  it('refuses anything without a usable title: no object, a missing title, a non-string field', () => {
    expect(parseCaptureTidy('I could not do that.', 'raw')).toBeNull();
    expect(parseCaptureTidy('{"description": "No title."}', 'raw')).toBeNull();
    expect(parseCaptureTidy('{"title": "  ", "description": "Blank."}', 'raw')).toBeNull();
    expect(parseCaptureTidy('{"title": "Fix", "description": 7}', 'raw')).toBeNull();
  });
});

describe('rawCaptureLogText (req-75 W5c)', () => {
  it('folds every run of whitespace, newlines included, into one space', () => {
    expect(rawCaptureLogText('  so   the palette\n\nflickers\tat startup ')).toBe(
      'raw capture: so the palette flickers at startup',
    );
  });

  it('cuts the whole line to 2000 characters', () => {
    const out = rawCaptureLogText(`${'a'.repeat(2500)}\n${'b'.repeat(100)}`);
    expect(out.length).toBe(2000);
    expect(out.startsWith('raw capture: ')).toBe(true);
  });
});
