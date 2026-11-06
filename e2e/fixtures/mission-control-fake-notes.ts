/**
 * The fake desk's Notes API (req-100's routes, req-101's e2e): a small
 * in-memory vault that the two POSTs mutate, a read-only switch and a
 * one-shot conflict. `notesReply` answers one call, or null when the path
 * is no Notes route; the fake desk (`mission-control-fake-desk.ts`) wires it.
 */
export const NOTES_FIXTURE = {
  vault: 'Main vault',
  files: new Map<string, { text: string; mtime: number }>(),
  reset(): void {
    this.files.clear();
    this.files.set('Welcome.md', { text: '# Welcome\n\nThe first note. #start\n', mtime: 1_700_000_300_000 });
    this.files.set('ideas/Plan.md', { text: '---\nticket: T-0050\n---\n# Plan\n\nShip it. #idea\n', mtime: 1_700_000_200_000 });
    this.files.set('ideas/Later.md', { text: '# Later\n\nMaybe.\n', mtime: 1_700_000_100_000 });
    this.conflictOnce = null;
    this.readOnly = false;
  },
  /** When set, the next save answers a conflict with this disk state. */
  conflictOnce: null as { text: string; mtime: number } | null,
  readOnly: false,
};
NOTES_FIXTURE.reset();

const noteEntry = (path: string) => {
  const file = NOTES_FIXTURE.files.get(path)!;
  return { path, name: path.split('/').pop()!.replace(/\.md$/, ''), mtime: file.mtime, size: file.text.length };
};

export function isNotesPath(pathname: string): boolean {
  return pathname === '/api/notes' || pathname.startsWith('/api/notes/');
}

export function notesReply(method: string, url: URL, body: Record<string, unknown>): { status: number; body: unknown } {
  const p = url.pathname;
  const paths = [...NOTES_FIXTURE.files.keys()];
  if (method === 'GET' && p === '/api/notes') {
    const folder = url.searchParams.get('folder') ?? '';
    const prefix = folder === '' ? '' : `${folder}/`;
    const inside = paths.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
    const folders = [...new Set(inside.filter((f) => f.includes('/')).map((f) => f.split('/')[0]!))];
    return {
      status: 200,
      body: {
        ok: true,
        vault: NOTES_FIXTURE.vault,
        folder,
        folders: folders.map((name) => ({ path: `${prefix}${name}`, name })),
        notes: inside.filter((f) => !f.includes('/')).map((f) => noteEntry(`${prefix}${f}`)),
      },
    };
  }
  if (method === 'GET' && p === '/api/notes/recent') {
    const notes = paths.map(noteEntry).sort((a, b) => b.mtime - a.mtime).slice(0, 8);
    return { status: 200, body: { ok: true, vault: NOTES_FIXTURE.vault, notes } };
  }
  if (method === 'GET' && p === '/api/notes/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const hits = paths
      .filter((f) => NOTES_FIXTURE.files.get(f)!.text.toLowerCase().includes(q))
      .map((f) => ({
        ...noteEntry(f),
        lines: [{ line: 1, heading: '', text: NOTES_FIXTURE.files.get(f)!.text.split('\n').find((l) => l.toLowerCase().includes(q)) ?? '' }],
      }));
    return { status: 200, body: { ok: true, query: q, hits, truncated: false } };
  }
  if (method === 'GET' && p === '/api/notes/note') {
    const path = url.searchParams.get('path') ?? '';
    const file = NOTES_FIXTURE.files.get(path);
    if (file === undefined) {
      return { status: 404, body: { ok: false, code: 'not_found', error: 'no such note' } };
    }
    const tags = [...file.text.matchAll(/(?:^|\s)#([a-z][\w/-]*)/g)].map((m) => m[1]!);
    return { status: 200, body: { ok: true, path, name: noteEntry(path).name, text: file.text, body: file.text, tags, mtime: file.mtime } };
  }
  if (method === 'POST' && (p === '/api/notes/note' || p === '/api/notes')) {
    if (NOTES_FIXTURE.readOnly) {
      return { status: 403, body: { ok: false, code: 'read_only', error: 'this device is paired read-only' } };
    }
    const path = String(body['path'] ?? '');
    if (p === '/api/notes') {
      if (NOTES_FIXTURE.files.has(path)) {
        return { status: 200, body: { ok: false, code: 'exists', error: 'exists' } };
      }
      const created = { text: String(body['text'] ?? ''), mtime: Date.now() };
      NOTES_FIXTURE.files.set(path, created);
      return { status: 200, body: { ok: true, path, text: created.text, mtime: created.mtime } };
    }
    const file = NOTES_FIXTURE.files.get(path);
    if (file === undefined) {
      return { status: 404, body: { ok: false, code: 'not_found', error: 'no such note' } };
    }
    if (NOTES_FIXTURE.conflictOnce !== null) {
      const disk = NOTES_FIXTURE.conflictOnce;
      NOTES_FIXTURE.conflictOnce = null;
      NOTES_FIXTURE.files.set(path, { text: disk.text, mtime: disk.mtime });
      return { status: 200, body: { ok: false, code: 'conflict', error: 'changed', disk } };
    }
    if (body['baseMtime'] !== file.mtime) {
      return { status: 200, body: { ok: false, code: 'conflict', error: 'changed', disk: { text: file.text, mtime: file.mtime } } };
    }
    const saved = { text: String(body['text'] ?? ''), mtime: file.mtime + 1000 };
    NOTES_FIXTURE.files.set(path, saved);
    return { status: 200, body: { ok: true, path, text: saved.text, mtime: saved.mtime } };
  }
  return { status: 404, body: { ok: false, code: 'bad_request', error: 'no such notes route' } };
}
