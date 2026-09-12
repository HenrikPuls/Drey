import {
  MAX_EXTRA_FILES,
  MAX_FILE_CHARS,
  parseAskPayload,
  truncateFileBody,
} from '../../../plugins/assistant/shared/ask';

/**
 * Specs for the ask contract between the assistant panel and its main
 * engine (`plugins/assistant/shared/ask.ts`): the strict payload check the
 * main-side `ask` handler delegates to (the bug-10 visible-failure rule)
 * and the per-file truncation for oversized attachments. The Angular
 * runner ignores `plugins/**`, so plugin specs live here and import the
 * plugin sources.
 */

const VALID = {
  question: 'Was steht hier?',
  note: { path: 'a.md', body: 'Inhalt.' },
  extraFiles: [{ path: 'b.md', body: 'B.' }],
  history: [{ role: 'user', content: 'Frage?' }],
};

describe('assistant plugin ask contract (plugins/assistant/shared/ask)', () => {
  it('parses a valid payload into request, taskId and history', () => {
    const parsed = parseAskPayload({ ...VALID, taskId: 'task-1' });

    expect(parsed.request).toEqual({
      question: 'Was steht hier?',
      note: { path: 'a.md', body: 'Inhalt.' },
      extraFiles: [{ path: 'b.md', body: 'B.' }],
    });
    expect(parsed.taskId).toBe('task-1');
    expect(parsed.history).toEqual([{ role: 'user', content: 'Frage?' }]);
  });

  it('accepts note: null (the note chip deselected) and an empty attachment list', () => {
    const parsed = parseAskPayload({
      question: 'q',
      note: null,
      extraFiles: [],
      history: [],
    });

    expect(parsed.request.note).toBeNull();
    expect(parsed.request.extraFiles).toEqual([]);
    expect(parsed.taskId).toBeUndefined();
  });

  it('rejects a payload without a string question', () => {
    expect(() => parseAskPayload({ ...VALID, question: 42 })).toThrow('malformed ask payload');
    expect(() => parseAskPayload({ note: null, extraFiles: [], history: [] })).toThrow(
      'malformed ask payload',
    );
  });

  it('rejects a malformed note or attachment entry', () => {
    expect(() => parseAskPayload({ ...VALID, note: { path: 'a.md' } })).toThrow(
      /note must be \{ path, body \} or null/,
    );
    expect(() => parseAskPayload({ ...VALID, extraFiles: 'b.md' })).toThrow(/extraFiles/);
    expect(() =>
      parseAskPayload({ ...VALID, extraFiles: [{ path: 1, body: 'x' }] }),
    ).toThrow(/extraFiles/);
  });

  it('keeps the bug-10 rule: a missing history fails visibly', () => {
    const { history: _dropped, ...noHistory } = { ...VALID, taskId: 't' } as Record<
      string,
      unknown
    >;
    void _dropped;
    expect(() => parseAskPayload(noHistory)).toThrow(
      'malformed ask payload: history must be an array (stale renderer or main process? restart the app)',
    );
    expect(() => parseAskPayload({ ...VALID, history: ['nope'] })).toThrow(
      'malformed ask payload: history entries must be { role, content }',
    );
  });

  it('truncates an oversized body with a visible marker, and only then', () => {
    const small = 'x'.repeat(1000);
    expect(truncateFileBody(small)).toBe(small);

    const big = 'y'.repeat(MAX_FILE_CHARS + 500);
    const truncated = truncateFileBody(big);
    expect(truncated.startsWith('y'.repeat(MAX_FILE_CHARS))).toBe(true);
    expect(truncated.endsWith('[file truncated]')).toBe(true);
    expect(truncated.length).toBeLessThan(big.length);
  });

  it('exposes the attachment cap the composer and the engine agree on', () => {
    expect(MAX_EXTRA_FILES).toBeGreaterThan(0);
    expect(MAX_FILE_CHARS).toBeGreaterThan(0);
  });
});
