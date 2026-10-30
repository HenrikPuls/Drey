import { describe, expect, it } from 'vitest';
import { formatUtcStamp } from '../shared/tickets';
import {
  newTicketFileText,
  parseTicketFile,
  patchHeaderFields,
  patchTicketFile,
  ticketPathParts,
} from './ticket-files';

const CANONICAL = [
  '---',
  "id: T-0042",
  'title: "Fix the palette race in CI"',
  'repo: drey',
  'priority: high',
  'rank: 5000',
  'branch: t/T-0042',
  "entered-inbox: '2026-10-17T14:32:00Z'",
  '---',
  '',
  '## Description',
  '',
  'The palette race.',
  '',
  '## Plan',
  '',
  'Nothing yet.',
  '',
  '## Log',
  '',
  "- '2026-10-17T14:32:00Z' owner@desk — created in inbox",
  '',
].join('\n');

describe('ticketPathParts', () => {
  it('splits ticket-shaped paths into dir, phase and stem', () => {
    expect(ticketPathParts('tickets/inbox/T-0042.md')).toEqual({
      phaseDir: 'inbox',
      phase: 'inbox',
      stem: 'T-0042',
    });
  });

  it('strips a numbered directory prefix (T-0041)', () => {
    expect(ticketPathParts('tickets/10-inbox/T-0042.md')).toEqual({
      phaseDir: '10-inbox',
      phase: 'inbox',
      stem: 'T-0042',
    });
    expect(ticketPathParts('tickets/35-qa/T-0100.md')!.phase).toBe('qa');
  });

  it('rejects non-ticket paths', () => {
    expect(ticketPathParts('tickets/inbox/readme.md')).toBeNull();
    expect(ticketPathParts('tickets/T-0042.md')).toBeNull();
    expect(ticketPathParts('notes/inbox/T-0042.md')).toBeNull();
  });
});

describe('parseTicketFile', () => {
  it('reads a canonical file without findings', () => {
    const parsed = parseTicketFile(CANONICAL, 'tickets/inbox/T-0042.md');
    expect(parsed.issues).toEqual([]);
    expect(parsed.meta.id).toBe('T-0042');
    expect(parsed.meta.title).toBe('Fix the palette race in CI');
    expect(parsed.meta.repo).toBe('drey');
    expect(parsed.meta.priority).toBe('high');
    expect(parsed.meta.rank).toBe(5000);
    expect(parsed.meta.branch).toBe('t/T-0042');
    expect(parsed.meta.entered['inbox']).toBe('2026-10-17T14:32:00Z');
  });

  it('reads the same file from a numbered directory without noise (T-0041)', () => {
    // The entered-inbox stamp must satisfy the reader through the stripped id.
    const parsed = parseTicketFile(CANONICAL, 'tickets/10-inbox/T-0042.md');
    expect(parsed.issues).toEqual([]);
    expect(parsed.meta.entered['inbox']).toBe('2026-10-17T14:32:00Z');
  });

  it('normalizes human tolerance visibly — missing priority, odd rank, unknown key', () => {
    const text = [
      '---',
      'id: T-0007',
      "title: 'Hand edit'",
      '# a comment the round-trip must keep',
      'rank: soon',
      'entered-inbox: 2026-10-17T09:00:00Z',
      'mood: sunny',
      '---',
      'body',
    ].join('\n');
    const parsed = parseTicketFile(text, 'tickets/inbox/T-0007.md');
    expect(parsed.meta.priority).toBe('normal');
    expect(parsed.meta.rank).toBe(5000);
    expect(parsed.meta.entered['inbox']).toBe('2026-10-17T09:00:00Z');
    const messages = parsed.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('priority');
    expect(messages).toContain('rank');
  });

  it('flags id/filename mismatch, branch rule violations, and run shape', () => {
    const text = [
      '---',
      'id: T-0009',
      'title: x',
      'branch: t/something-else',
      'run: {pid: not-a-number}',
      '---',
      '',
    ].join('\n');
    const parsed = parseTicketFile(text, 'tickets/build/T-0001.md');
    const messages = parsed.issues.map((i) => i.message).join('\n');
    expect(messages).toContain('id T-0009 does not match file name T-0001');
    expect(messages).toContain('branch "t/something-else" violates the rule');
    expect(messages).toContain('run');
    // The rule wins:
    expect(parsed.meta.branch).toBe('t/T-0001');
  });

  it('refuses a file without a parseable fence', () => {
    const noFence = parseTicketFile('just body', 'tickets/inbox/T-0002.md');
    expect(noFence.issues[0]!.level).toBe('error');
    const badYaml = parseTicketFile('---\nid: [broken\n---\n', 'tickets/inbox/T-0003.md');
    expect(badYaml.issues[0]!.level).toBe('error');
  });
});

describe('patchTicketFile', () => {
  const now = new Date('2026-10-17T15:01:12Z');

  it('stamps the phase, appends the log line, preserves everything else', () => {
    const patched = patchTicketFile(CANONICAL, {
      to: 'prioritized',
      from: 'inbox',
      now,
      actor: 'owner@desk',
    });
    expect(patched).toContain("entered-prioritized: '2026-10-17T15:01:12Z'");
    expect(patched).toContain("entered-inbox: '2026-10-17T14:32:00Z'");
    expect(patched).toContain("- '2026-10-17T15:01:12Z' owner@desk — inbox -> prioritized");
    // Untouched content:
    expect(patched).toContain('The palette race.');
    expect(patched).toContain('## Plan');
    expect(patched).not.toContain('claimed-by');
  });

  it('claims on the way into a claim phase and logs with the claimant', () => {
    const patched = patchTicketFile(CANONICAL, {
      to: 'build',
      from: 'prioritized',
      now,
      actor: 'owner@desk',
      claimBy: 'owner@desk',
    });
    expect(patched).toContain("claimed-by: 'owner@desk'");
    expect(patched).toContain("claimed-at: '2026-10-17T15:01:12Z'");
  });

  it('clears parked fields when leaving the inbox', () => {
    const parked = CANONICAL.replace(
      "entered-inbox: '2026-10-17T14:32:00Z'",
      "entered-inbox: '2026-10-17T14:32:00Z'\nparked-reason: 'waiting on the agent'\nparked-at: '2026-10-17T14:40:00Z'",
    );
    const patched = patchTicketFile(parked, { to: 'prioritized', from: 'inbox', now, actor: 'owner@desk' });
    expect(patched).not.toContain('parked-reason');
    expect(patched).not.toContain('parked-at');
  });

  it('a claim-only patch never restamps entered-<phase>', () => {
    const patched = patchTicketFile(CANONICAL, {
      to: 'inbox',
      from: null,
      now,
      actor: 'owner@desk',
      action: 'claim takeover (was agent@host:abc)',
      claimBy: 'owner@desk',
    });
    expect(patched).toContain("claimed-by: 'owner@desk'");
    expect(patched).not.toContain(`entered-inbox: '${formatUtcStamp(now)}'`);
    expect(patched).toContain('claim takeover (was agent@host:abc)');
  });

  it('a release clears the claim fields', () => {
    const claimed = CANONICAL.replace(
      "entered-inbox: '2026-10-17T14:32:00Z'",
      "entered-inbox: '2026-10-17T14:32:00Z'\nclaimed-by: 'owner@desk'\nclaimed-at: '2026-10-17T14:40:00Z'",
    );
    const patched = patchTicketFile(claimed, {
      to: 'build',
      from: null,
      now,
      actor: 'owner@desk',
      action: 'claim release',
      releaseClaim: true,
    });
    expect(patched).not.toContain('claimed-by');
    expect(patched).not.toContain('claimed-at');
  });

  it('appends a Log section when the human removed it', () => {
    const noLog = CANONICAL.split('## Log')[0]!.trimEnd() + '\n';
    const patched = patchTicketFile(noLog, { to: 'prioritized', from: 'inbox', now, actor: 'owner@desk' });
    expect(patched).toContain('## Log');
    expect(patched.trimEnd().endsWith("- '2026-10-17T15:01:12Z' owner@desk — inbox -> prioritized")).toBe(true);
  });

  it("an unarchive patch logs 'archive -> <phase>' and stamps entered-<phase> (T-0042)", () => {
    const patched = patchTicketFile(CANONICAL, {
      to: 'prioritized',
      from: 'archive',
      now,
      actor: 'owner@desk',
    });
    expect(patched).toContain("entered-prioritized: '2026-10-17T15:01:12Z'");
    expect(patched).toContain("- '2026-10-17T15:01:12Z' owner@desk — archive -> prioritized");
  });
});

describe('newTicketFileText', () => {
  it('writes the strict canonical shape', () => {
    const text = newTicketFileText({
      id: 'T-0001',
      title: 'First ticket',
      repo: null,
      priority: 'normal',
      rank: 5000,
      firstPhase: 'inbox',
      now: new Date('2026-10-17T14:32:00Z'),
      actor: 'owner@desk',
      description: 'Do the thing.',
    });
    const parsed = parseTicketFile(text, 'tickets/inbox/T-0001.md');
    expect(parsed.issues).toEqual([]);
    expect(parsed.meta.title).toBe('First ticket');
    expect(text).toContain('## Description');
    expect(text).toContain('Do the thing.');
    expect(text).toContain('- \'2026-10-17T14:32:00Z\' owner@desk — created in inbox');
  });
});

describe('patchHeaderFields (req-62)', () => {
  const BLOCK = CANONICAL.slice(0, CANONICAL.indexOf('---\n\n') + 3);

  it('rewrites only the named keys and keeps the block shape (fences, no trailing newline)', () => {
    const out = patchHeaderFields(BLOCK, { priority: 'low' });
    expect(out).toBe(BLOCK.replace('priority: high', 'priority: low'));
  });

  it('quotes a title with a colon and keeps the existing double-quote style', () => {
    const out = patchHeaderFields(BLOCK, { title: 'CI: fix  the race ' });
    expect(out).toContain('title: "CI: fix the race"');
    expect(parseTicketFile(`${out}\n`, 'tickets/inbox/T-0042.md').meta.title).toBe('CI: fix the race');
  });

  it("keeps the owner's single quotes", () => {
    const block = BLOCK.replace('title: "Fix the palette race in CI"', "title: 'Old'");
    expect(patchHeaderFields(block, { title: "It's new" })).toContain("title: 'It''s new'");
  });

  it('refuses an empty title and an unknown priority', () => {
    expect(() => patchHeaderFields(BLOCK, { title: '  ' })).toThrow('the title is empty');
    expect(() => patchHeaderFields(BLOCK, { priority: 'asap' as never })).toThrow('unknown priority');
  });

  it('an empty repo stays as an empty key; an empty worker removes the pin', () => {
    const cleared = patchHeaderFields(BLOCK, { repo: '' });
    expect(cleared).toContain('\nrepo:\n');
    const pinned = patchHeaderFields(BLOCK, { worker: 'claude-code' });
    expect(pinned).toContain("worker: 'claude-code'");
    expect(patchHeaderFields(pinned, { worker: '' })).not.toContain('worker:');
  });

  it('refuses a block without fences or with broken YAML', () => {
    expect(() => patchHeaderFields('id: T-0042', { priority: 'low' })).toThrow('no frontmatter fence');
    expect(() => patchHeaderFields('---\nid: [\n---', { priority: 'low' })).toThrow('does not parse');
  });
});
