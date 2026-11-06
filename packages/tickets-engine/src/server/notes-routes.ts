/**
 * The Notes API's routes (req-100; table in `contracts/notes.ts`). Status
 * codes follow the router's rule: transport and access answer with a status,
 * and a refusal the client must act on (`conflict`, `exists`) is a 200 with
 * `{ ok: false, code }`, so its body survives the client's error path.
 */
import type { NoteCreateRequest, NoteSaveRequest, NotesAccess, NotesErrorCode } from '../contracts/notes';
import type { RemoteRequest, RemoteResponse } from './router';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

const STATUS_OF: Readonly<Record<NotesErrorCode, number>> = {
  read_only: 403,
  conflict: 200,
  exists: 200,
  not_found: 404,
  bad_path: 400,
  bad_request: 400,
  no_vault: 404,
  too_large: 413,
  internal: 500,
};

export function notesFailure(code: NotesErrorCode, error: string): RemoteResponse {
  return { status: STATUS_OF[code], body: { ok: false, code, error } };
}

const answer = (reply: { readonly ok: boolean; readonly code?: NotesErrorCode }): RemoteResponse => ({
  status: reply.ok || reply.code === undefined ? 200 : STATUS_OF[reply.code],
  body: reply,
});

/** Whether a path belongs to this API; the read-only refusal needs to know before it dispatches. */
export function isNotesPath(path: string): boolean {
  return path === '/api/notes' || path.startsWith('/api/notes/');
}

function limitOf(query: URLSearchParams | undefined): number {
  const raw = Number(query?.get('limit') ?? DEFAULT_LIMIT);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT;
}

function asObject(body: unknown): Record<string, unknown> | null {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function parseSave(body: unknown): NoteSaveRequest | null {
  const obj = asObject(body);
  const { path, text, baseMtime } = obj ?? {};
  return typeof path === 'string' && typeof text === 'string' && typeof baseMtime === 'number' && Number.isFinite(baseMtime)
    ? { path, text, baseMtime }
    : null;
}

function parseCreate(body: unknown): NoteCreateRequest | null {
  const obj = asObject(body);
  const { path, text } = obj ?? {};
  if (typeof path !== 'string' || (text !== undefined && typeof text !== 'string')) {
    return null;
  }
  return text === undefined ? { path } : { path, text };
}

/** Answers one notes request; the caller has already checked the device and refused read-only writes. */
export async function routeNotes(req: RemoteRequest, notes: NotesAccess, device: string, log: (message: string) => void): Promise<RemoteResponse> {
  try {
    return await dispatchNotes(req, notes, device);
  } catch (error) {
    log(`remote ${device}: ${req.method} ${req.path} failed: ${error instanceof Error ? error.message : String(error)}`);
    return notesFailure('internal', 'the request failed on the desk');
  }
}

async function dispatchNotes(req: RemoteRequest, notes: NotesAccess, device: string): Promise<RemoteResponse> {
  if (req.method === 'GET') {
    switch (req.path) {
      case '/api/notes':
        return answer(await notes.list(req.query?.get('folder')));
      case '/api/notes/recent':
        return answer(await notes.recent(limitOf(req.query)));
      case '/api/notes/search':
        return answer(await notes.search(req.query?.get('q') ?? '', limitOf(req.query)));
      case '/api/notes/note':
        return answer(await notes.read(req.query?.get('path')));
    }
    return notesFailure('not_found', 'no such route');
  }
  if (req.method !== 'POST') {
    return { status: 405, body: { ok: false, code: 'bad_request', error: 'only GET and POST are served here' } };
  }
  if (req.path === '/api/notes/note') {
    const save = parseSave(req.body);
    return save === null ? notesFailure('bad_request', 'a save needs path, text and baseMtime') : answer(await notes.save(save, device));
  }
  if (req.path === '/api/notes') {
    const create = parseCreate(req.body);
    return create === null ? notesFailure('bad_request', 'a new note needs a path') : answer(await notes.create(create, device));
  }
  return notesFailure('not_found', 'no such route');
}
