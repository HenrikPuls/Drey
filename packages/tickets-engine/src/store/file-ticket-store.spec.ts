import { describe, expect, it } from 'vitest';

import { newTicketFileText, parseTicketFile } from '../core/ticket-files';
import { FileTicketStore, type FileTicketIo } from './file-ticket-store';

const NOW = new Date('2026-11-04T10:00:00Z');

function ticket(id: string, title: string, phase: string): { path: string; text: string } {
  return {
    path: `tickets/${phase}/${id}.md`,
    text: newTicketFileText({ id, title, repo: 'drey', priority: 'normal', rank: 1, firstPhase: phase, now: NOW, actor: 'owner@test', description: 'Do the thing.' }),
  };
}

function fakeIo(files: Array<{ path: string; text: string }>): { io: FileTicketIo; files: Map<string, string>; commits: string[]; announced: string[][] } {
  const map = new Map(files.map((f) => [f.path, f.text]));
  const commits: string[] = [];
  const announced: string[][] = [];
  const io: FileTicketIo = {
    listMarkdownFiles: () => Promise.resolve([...map.keys(), 'tickets/_meta/pipeline.md', 'notes/other.md']),
    read: (p) => (map.has(p) ? Promise.resolve(map.get(p)!) : Promise.reject(new Error(`no ${p}`))),
    write: (p, text) => {
      map.set(p, text);
      return Promise.resolve();
    },
    commit: (_paths, message) => {
      commits.push(message);
      return Promise.resolve(null);
    },
    announce: (paths) => {
      announced.push([...paths]);
    },
  };
  return { io, files: map, commits, announced };
}

describe('FileTicketStore (today\'s files behind the port)', () => {
  const seed = [ticket('T-0001', 'First', 'inbox'), ticket('T-0002', 'Second', 'build')];

  it('lists tickets with the phase as the stage; ignores _meta and non-ticket files', async () => {
    const { io } = fakeIo(seed);
    const rows = await new FileTicketStore(io).list();
    expect(rows.map((r) => [r.id, r.stage, r.title, r.owner])).toEqual([
      ['T-0001', 'inbox', 'First', null],
      ['T-0002', 'build', 'Second', null],
    ]);
    expect((await new FileTicketStore(io).list({ stage: 'build' })).map((r) => r.id)).toEqual(['T-0002']);
  });

  it('shows the file and its body', async () => {
    const t = await new FileTicketStore(fakeIo(seed).io).show('T-0001');
    expect(t.text).toBe(seed[0]!.text);
    expect(t.body).toContain('Do the thing.');
    expect(t.body.startsWith('---')).toBe(false);
    await expect(new FileTicketStore(fakeIo(seed).io).show('T-0099')).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('claims and releases exactly like setClaim: the same stamps, one commit, one announce', async () => {
    const { io, files, commits, announced } = fakeIo(seed);
    const store = new FileTicketStore(io);
    const claim = await store.claim('T-0002', { actor: 'ben.run-1' });
    expect(claim).toEqual({ id: 'T-0002', epoch: null, leaseUntil: null, takeover: false });
    expect(parseTicketFile(files.get('tickets/build/T-0002.md')!, 'tickets/build/T-0002.md').meta.claimedBy).toBe('ben.run-1');
    expect(commits).toEqual(['tickets: T-0002 claim takeover']);
    expect(announced).toEqual([['tickets/build/T-0002.md']]);
    expect((await store.list({ owner: 'ben.run-1' })).map((r) => r.id)).toEqual(['T-0002']);

    await expect(store.claim('T-0002', { actor: 'ben.run-1' })).rejects.toMatchObject({ kind: 'claimed', message: 'you already hold this claim' });
    const again = await store.claim('T-0002', { actor: 'other' });
    expect(again.takeover).toBe(true);

    expect(await store.release('T-0002', { actor: 'other' })).toEqual({ id: 'T-0002', stage: 'build' });
    expect(parseTicketFile(files.get('tickets/build/T-0002.md')!, 'tickets/build/T-0002.md').meta.claimedBy).toBeNull();
    await expect(store.release('T-0002', { actor: 'other' })).rejects.toMatchObject({ kind: 'invalid', message: 'this ticket is not claimed' });
  });

  it('does not pretend to move, lease or comment', async () => {
    const store = new FileTicketStore(fakeIo(seed).io);
    await expect(store.release('T-0001', { actor: 'a', stage: 'review' })).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(store.extend('T-0001', { actor: 'a', reason: 'x' })).rejects.toMatchObject({ kind: 'unsupported' });
    expect(await store.comments('T-0001')).toEqual([]);
    expect(await store.capabilities()).toEqual({ backend: 'files', comments: false, leases: false, version: null });
  });
});
