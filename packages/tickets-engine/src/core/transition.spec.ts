import { describe, expect, it } from 'vitest';
import { newTicketFileText } from './ticket-files';
import { runTransition, type TransitionIo, type TransitionSpec } from './transition';

/** An in-memory host: files, a commit/push log and the last announcement. */
function fakeIo(files: Map<string, string>, opts?: { renameFails?: string; readFails?: Set<string> }) {
  const commits: { paths: readonly string[]; message: string }[] = [];
  const pushes: (string | null)[] = [];
  let announced: { changed: readonly string[]; deleted: readonly string[] } | null = null;
  const io: TransitionIo = {
    async read(path) {
      if (opts?.readFails?.has(path)) {
        throw new Error('ENOENT (fake)');
      }
      const text = files.get(path);
      if (text === undefined) {
        throw new Error(`missing ${path}`);
      }
      return text;
    },
    async write(path, text) {
      files.set(path, text);
    },
    async renameInto(fromPath, toPath) {
      if (opts?.renameFails !== undefined) {
        return { ok: false, error: opts.renameFails };
      }
      const text = files.get(fromPath);
      if (text === undefined) {
        return { ok: false, error: `move failed: missing ${fromPath}` };
      }
      files.delete(fromPath);
      files.set(toPath, text);
      return { ok: true };
    },
    async commit(paths, message) {
      commits.push({ paths, message });
      return null;
    },
    async push(remote) {
      pushes.push(remote);
      return null;
    },
    announce(changed, deleted) {
      announced = { changed, deleted };
    },
  };
  return { io, files, commits, pushes, announced: () => announced };
}

const NOW = new Date('2026-11-01T12:00:00Z');

function seedTicket(files: Map<string, string>, id = 'T-0001'): string {
  const path = `tickets/10-inbox/${id}.md`;
  files.set(
    path,
    newTicketFileText({
      id,
      title: 'Seed',
      repo: null,
      priority: 'normal',
      rank: 5000,
      firstPhase: 'inbox',
      now: NOW,
      actor: 'owner@desk',
      description: 'body',
    }),
  );
  return path;
}

function spec(overrides: Partial<TransitionSpec>): TransitionSpec {
  return {
    id: 'T-0001',
    fromPath: 'tickets/10-inbox/T-0001.md',
    patch: { to: 'build', from: 'inbox', now: NOW, actor: 'owner@desk' },
    commitMessage: 'tickets: T-0001 inbox -> build',
    pushRemote: null,
    ...overrides,
  };
}

describe('runTransition', () => {
  it('patches, renames, commits both paths, pushes and announces once', async () => {
    const files = new Map<string, string>();
    const from = seedTicket(files);
    const host = fakeIo(files);

    const result = await runTransition(host.io, spec({ toPath: 'tickets/40-build/T-0001.md', pushRemote: 'origin' }));

    expect(result.ok).toBe(true);
    const written = files.get('tickets/40-build/T-0001.md')!;
    expect(written).toContain('entered-build');
    expect(written).toContain('inbox -> build');
    expect(files.has(from)).toBe(false);
    expect(host.commits).toEqual([
      { paths: ['tickets/10-inbox/T-0001.md', 'tickets/40-build/T-0001.md'], message: 'tickets: T-0001 inbox -> build' },
    ]);
    expect(host.pushes).toEqual(['origin']);
    expect(host.announced()).toEqual({
      changed: ['tickets/40-build/T-0001.md'],
      deleted: ['tickets/10-inbox/T-0001.md'],
    });
  });

  it('treats a drift correction in place: no rename, one commit path, nothing deleted', async () => {
    const files = new Map<string, string>();
    const path = seedTicket(files);
    const host = fakeIo(files);

    const result = await runTransition(
      host.io,
      spec({
        text: files.get(path)!,
        toPath: undefined,
        commitMessage: 'tickets: T-0001 unknown -> inbox',
      }),
    );

    expect(result).toEqual({ ok: true, path });
    expect(host.commits).toEqual([{ paths: [path], message: 'tickets: T-0001 unknown -> inbox' }]);
    expect(host.announced()).toEqual({ changed: [path], deleted: [] });
  });

  it('appends the extra Log line after the ordinary transition line (send back)', async () => {
    const files = new Map<string, string>();
    seedTicket(files);
    const host = fakeIo(files);

    await runTransition(
      host.io,
      spec({ extraLog: 'sent back: the gate log', toPath: 'tickets/40-build/T-0001.md' }),
    );

    const written = files.get('tickets/40-build/T-0001.md')!;
    expect(written.indexOf('inbox -> build')).toBeLessThan(written.indexOf('sent back: the gate log'));
  });

  it('returns a patch failure without committing or announcing', async () => {
    const files = new Map<string, string>();
    seedTicket(files);
    const host = fakeIo(files);
    host.io.read = async () => 'no frontmatter fence at all';

    const result = await runTransition(host.io, spec({}));

    expect(result).toEqual({ ok: false, error: 'ticket has no frontmatter fence' });
    expect(host.commits).toEqual([]);
    expect(host.announced()).toBeNull();
  });

  it('keeps the rename failure wording verbatim and aborts before the commit', async () => {
    const files = new Map<string, string>();
    seedTicket(files);
    const host = fakeIo(files, { renameFails: 'ticket path escapes the vault' });

    const result = await runTransition(host.io, spec({ toPath: 'tickets/40-build/T-0001.md' }));

    expect(result).toEqual({ ok: false, error: 'ticket path escapes the vault' });
    expect(host.commits).toEqual([]);
    expect(host.announced()).toBeNull();
  });

  it('reports a write failure as a failed move', async () => {
    const files = new Map<string, string>();
    seedTicket(files);
    const host = fakeIo(files);
    host.io.write = async () => {
      throw new Error('disk full');
    };

    const result = await runTransition(host.io, spec({ toPath: 'tickets/40-build/T-0001.md' }));

    expect(result).toEqual({ ok: false, error: 'move failed: disk full' });
    expect(host.commits).toEqual([]);
  });

  it('joins commit and push warnings without failing the move', async () => {
    const files = new Map<string, string>();
    seedTicket(files);
    const host = fakeIo(files);
    host.io.commit = async () => 'git commit failed: nothing staged';
    host.io.push = async () => 'git push to "origin" failed: offline';

    const result = await runTransition(host.io, spec({ toPath: 'tickets/40-build/T-0001.md', pushRemote: 'origin' }));

    expect(result).toEqual({
      ok: true,
      path: 'tickets/40-build/T-0001.md',
      warning: 'git commit failed: nothing staged; git push to "origin" failed: offline',
    });
  });

  it('returns the spec readError instead of propagating a read failure', async () => {
    const files = new Map<string, string>();
    const host = fakeIo(files, { readFails: new Set(['tickets/10-inbox/T-0001.md']) });

    const result = await runTransition(host.io, spec({ readError: 'T-0001 is not in the archive' }));

    expect(result).toEqual({ ok: false, error: 'T-0001 is not in the archive' });
  });

  it('propagates a read failure when the spec names no readError', async () => {
    const files = new Map<string, string>();
    const host = fakeIo(files, { readFails: new Set(['tickets/10-inbox/T-0001.md']) });

    await expect(runTransition(host.io, spec({}))).rejects.toThrow('ENOENT (fake)');
  });
});
