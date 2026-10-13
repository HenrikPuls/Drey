import {
  LIVE_EDIT_TOOL_SPECS,
  createLiveEditSession,
} from './live-edit';

/**
 * Specs for the live-edit document tools (`plugins/assistant/main/live-edit.ts`,
 * ADR-0049): the pure main-side session the model drives through the
 * provider tool loop. The Angular runner ignores `plugins/**`, so plugin
 * specs live here — same convention as the other assistant specs.
 */

const DOC = [
  '# Meeting notes',
  '',
  '## Attendees',
  '- Anna',
  '- Bob',
  '',
  '## Tasks',
  '- [ ] call the marina',
  '- [ ] book the room',
  '',
];

function makeSession(work = DOC.join('\n')) {
  return createLiveEditSession('notes/meeting.md', work);
}

function args(value: unknown): string {
  return JSON.stringify(value);
}

describe('assistant plugin live-edit session (plugins/assistant/main/live-edit)', () => {
  it('applies a single unique hunk and reports the touched line', async () => {
    const session = makeSession();
    const run = await session.runTool(
      'doc_apply_diff',
      args({ hunks: [{ find: '- [ ] call the marina', replace: '- [x] call the marina' }] }),
    );

    expect(run.mutated).toBe(true);
    expect(run.text).toContain('1 hunk');
    expect(session.editCount).toBe(1);
    expect(session.work).toContain('- [x] call the marina');
    expect(session.work).toContain('- [ ] book the room');
  });

  it('applies several hunks in one atomic call, in order', async () => {
    const session = makeSession();
    const run = await session.runTool(
      'doc_apply_diff',
      args({
        hunks: [
          { find: '## Tasks\n- [ ] call the marina', replace: '## Tasks (done)\n- [x] call' },
          { find: '- [x] call\n- [ ] book the room', replace: '- [x] call\n- [x] book' },
        ],
      }),
    );

    expect(run.mutated).toBe(true);
    expect(session.editCount).toBe(2);
    // The second hunk matched only AFTER the first replacement — order held.
    expect(session.work).toContain('- [x] book');
    expect(session.work).not.toContain('- [ ]');
  });

  it('refuses a hunk with zero or several matches and applies NOTHING (atomic)', async () => {
    const session = makeSession();

    const zero = await session.runTool(
      'doc_apply_diff',
      args({ hunks: [{ find: 'not in the doc', replace: 'x' }] }),
    );
    expect(zero.mutated).toBe(false);
    expect(zero.text).toMatch(/Hunk 1 not found/i);

    const multi = await session.runTool(
      'doc_apply_diff',
      args({ hunks: [{ find: '- [ ]', replace: '- [x]' }] }),
    );
    expect(multi.mutated).toBe(false);
    expect(multi.text).toMatch(/found 2 times/);

    expect(session.work).toBe(DOC.join('\n'));
    expect(session.editCount).toBe(0);
  });

  it('rejects an empty find, a missing replace, and an empty hunks list', async () => {
    const session = makeSession();
    expect((await session.runTool('doc_apply_diff', args({ hunks: [{ find: '', replace: 'x' }] }))).mutated).toBe(false);
    expect((await session.runTool('doc_apply_diff', args({ hunks: [{ find: '## Tasks' }] }))).mutated).toBe(false);
    expect((await session.runTool('doc_apply_diff', args({ hunks: [] }))).mutated).toBe(false);
    expect((await session.runTool('doc_apply_diff', args({}))).mutated).toBe(false);
    expect(session.editCount).toBe(0);
  });

  it('doc_write replaces the whole document with normalized text', async () => {
    const session = makeSession();
    const run = await session.runTool(
      'doc_write',
      args({ content: '```\n# Fresh\n\nContent.\n```' }),
    );

    expect(run.mutated).toBe(true);
    expect(session.editCount).toBe(1);
    expect(session.work).toBe('# Fresh\n\nContent.\n');
    expect(session.work).not.toContain('```');
  });

  it('doc_read returns numbered lines, honours from/to, and never mutates', async () => {
    const session = makeSession();

    const full = await session.runTool('doc_read', args({}));
    expect(full.mutated).toBe(false);
    expect(full.text).toContain('   1|# Meeting notes');
    expect(full.text).not.toContain('… more lines');

    const window = await session.runTool('doc_read', args({ from: 4, to: 5 }));
    expect(window.text).toContain('   4|- Anna');
    expect(window.text).toContain('   5|- Bob');
    expect(window.text).not.toContain('# Meeting notes');
    expect(session.editCount).toBe(0);
  });

  it('caps an unbounded doc_read with a range hint', async () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const session = makeSession(long);

    const dump = await session.runTool('doc_read', args({}));
    expect(dump.text).toContain('   1|line 1');
    expect(dump.text).toContain('more lines');
    expect(dump.text).not.toContain('line 401');

    const tail = await session.runTool('doc_read', args({ from: 450, to: 500 }));
    expect(tail.text).toContain('450|line 450');
  });

  it('never throws: bad JSON and unknown tools come back as error text', async () => {
    const session = makeSession();
    expect((await session.runTool('doc_apply_diff', '{nope')).mutated).toBe(false);
    expect((await session.runTool('nonsense', args({}))).text).toMatch(/Unknown tool nonsense/);
    expect(session.work).toBe(DOC.join('\n'));
  });

  it('declares the three doc tools with object parameters', () => {
    expect(LIVE_EDIT_TOOL_SPECS.map((spec) => spec.name)).toEqual([
      'doc_apply_diff',
      'doc_write',
      'doc_read',
    ]);
    for (const spec of LIVE_EDIT_TOOL_SPECS) {
      expect(spec.parameters.type).toBe('object');
      expect(spec.description.length).toBeGreaterThan(0);
    }
    const diff = LIVE_EDIT_TOOL_SPECS[0];
    expect(diff.parameters.required).toEqual(['hunks']);
  });
});
