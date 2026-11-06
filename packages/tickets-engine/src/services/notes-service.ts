/**
 * The notes of the active vault for paired devices (req-100). The engine is
 * its own process and serves phones with Drey closed (concept §3.5), so it
 * reads and writes the files directly; the rules are Drey's own: the mtime
 * conflict guard of ADR-0060, an atomic replace, and `updated:` bumped only
 * where a note already has it. Drey hears of a write over the paths channel.
 *
 * What Drey's save does and this one cannot: plugin save hooks and the
 * local version history both live in the Drey process.
 */
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { readFrontmatter, splitFrontmatter, touchUpdated } from '../../../../shared/frontmatter';
import { findLines, queryTerms } from '../../../../shared/note-search';
import { extractInlineTags } from '../../../../shared/tag-grammar';
import type {
  NoteCreateReply,
  NoteCreateRequest,
  NoteEntry,
  NoteFolderEntry,
  NoteReadReply,
  NoteSaveReply,
  NoteSaveRequest,
  NoteSearchHit,
  NotesAccess,
  NotesChange,
  NotesErrorCode,
  NotesFailure,
  NotesListReply,
  NotesRecentReply,
  NotesSearchReply,
} from '../contracts/notes';
import { isNoteFileName, isServedChild, isServedPath, parseNoteFolder, parseNotePath } from '../core/note-path';

/** Same slack as `note:save`: two reads of one mtime may differ this much. */
const MTIME_TOLERANCE_MS = 2;
/** Bounds of one search, as in `vault_search`; the newest notes are scanned first. */
const SCAN_MAX_FILES = 2000;
const SCAN_MAX_CHARS_PER_FILE = 512 * 1024;
const LINES_PER_NOTE = 5;
const LINE_MAX_CHARS = 240;
const RENAME_RETRY_DELAYS_MS = [10, 40, 120];
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface NotesServiceDeps {
  /** The vault's absolute root right now. */
  readonly root: () => Promise<string>;
  readonly log: (message: string) => void;
  readonly now?: () => Date;
}

const failure = (code: Exclude<NotesErrorCode, 'conflict'>, error: string): NotesFailure => ({ ok: false, code, error });
const badPath = (): NotesFailure => failure('bad_path', 'this path is not a note or folder served here');
const notFound = (what: string): NotesFailure => failure('not_found', `no such ${what}`);
const noVault = (): NotesFailure => failure('no_vault', 'the vault folder is not available');

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

const isMissing = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const toLf = (text: string): string => text.replace(/\r\n/g, '\n');
const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '');
const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

export class NotesService implements NotesAccess {
  private readonly listeners = new Set<(change: NotesChange) => void>();
  /** Two devices saving at once: the guard and the write of each run one after the other. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: NotesServiceDeps) {}

  onChanged(listener: (change: NotesChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(rawFolder: unknown): Promise<NotesListReply> {
    const folder = parseNoteFolder(rawFolder);
    if (folder === null) {
      return badPath();
    }
    const root = await this.vaultRoot();
    if (root === null) {
      return noVault();
    }
    if (!(await this.staysServed(root, folder))) {
      return badPath();
    }
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, folder), { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) {
        return notFound('folder');
      }
      throw error;
    }
    const folders: NoteFolderEntry[] = [];
    const notes: NoteEntry[] = [];
    for (const entry of entries) {
      const rel = folder === '' ? entry.name : `${folder}/${entry.name}`;
      if (!isServedChild(folder, entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        folders.push({ path: rel, name: entry.name });
      } else if (entry.isFile() && isNoteFileName(entry.name)) {
        const note = await this.entryOf(root, rel);
        if (note !== null) {
          notes.push(note);
        }
      }
    }
    return { ok: true, vault: path.basename(root), folder, folders: folders.sort(byName), notes: notes.sort(byName) };
  }

  async recent(limit: number): Promise<NotesRecentReply> {
    const root = await this.vaultRoot();
    if (root === null) {
      return noVault();
    }
    const notes = await this.allNotesNewestFirst(root);
    return { ok: true, vault: path.basename(root), notes: notes.slice(0, limit) };
  }

  async search(query: string, limit: number): Promise<NotesSearchReply> {
    const terms = queryTerms(query);
    if (terms.length === 0) {
      return failure('bad_request', 'a search needs at least one word');
    }
    const root = await this.vaultRoot();
    if (root === null) {
      return noVault();
    }
    const notes = await this.allNotesNewestFirst(root);
    const hits: NoteSearchHit[] = [];
    let truncated = notes.length > SCAN_MAX_FILES;
    for (const note of notes.slice(0, SCAN_MAX_FILES)) {
      const text = await fsp.readFile(path.join(root, note.path), 'utf8').catch(() => null);
      if (text === null) {
        continue;
      }
      const content = toLf(text).slice(0, SCAN_MAX_CHARS_PER_FILE);
      const found = findLines(content, { kind: 'words', terms, caseSensitive: false });
      if (found.length === 0) {
        continue;
      }
      if (hits.length === limit) {
        truncated = true;
        break;
      }
      const lines = content.split('\n');
      hits.push({
        ...note,
        lines: found.slice(0, LINES_PER_NOTE).map((hit) => ({
          line: hit.line,
          heading: hit.heading,
          text: (lines[hit.line - 1] ?? '').trimEnd().slice(0, LINE_MAX_CHARS),
        })),
      });
    }
    return { ok: true, query, hits, truncated };
  }

  async read(rawPath: unknown): Promise<NoteReadReply> {
    const rel = parseNotePath(rawPath);
    if (rel === null) {
      return badPath();
    }
    const root = await this.vaultRoot();
    if (root === null) {
      return noVault();
    }
    if (!(await this.staysServed(root, rel))) {
      return badPath();
    }
    const disk = await this.readDisk(root, rel);
    if (disk === null) {
      return notFound('note');
    }
    return {
      ok: true,
      path: rel,
      name: nameOf(rel),
      text: disk.text,
      frontmatter: readFrontmatter(disk.text),
      body: splitFrontmatter(disk.text).body,
      tags: extractInlineTags(splitFrontmatter(disk.text).body),
      mtime: disk.mtime,
    };
  }

  save(request: NoteSaveRequest, device: string): Promise<NoteSaveReply> {
    return this.serial(() => this.saveNow(request, device));
  }

  create(request: NoteCreateRequest, device: string): Promise<NoteCreateReply> {
    return this.serial(() => this.createNow(request, device));
  }

  private async saveNow(request: NoteSaveRequest, device: string): Promise<NoteSaveReply> {
    const rel = parseNotePath(request.path);
    if (rel === null) {
      return badPath();
    }
    const root = await this.vaultRoot();
    if (root === null) {
      return noVault();
    }
    if (!(await this.staysServed(root, rel))) {
      return badPath();
    }
    const abs = path.join(root, rel);
    const raw = await fsp.readFile(abs, 'utf8').catch((error: unknown) => {
      if (isMissing(error) || errorCode(error) === 'EISDIR') {
        return null;
      }
      throw error;
    });
    if (raw === null) {
      return notFound('note');
    }
    const diskMtime = await this.mtimeOf(abs);
    if (Math.abs(diskMtime - request.baseMtime) > MTIME_TOLERANCE_MS) {
      return {
        ok: false,
        code: 'conflict',
        error: 'this note changed since it was opened',
        disk: { text: toLf(raw), mtime: diskMtime },
      };
    }
    const written = touchUpdated(toLf(request.text), this.now());
    await atomicWrite(abs, raw.includes('\r\n') ? written.replace(/\n/g, '\r\n') : written);
    return this.finish(root, rel, written, device, 'saved');
  }

  private async createNow(request: NoteCreateRequest, device: string): Promise<NoteCreateReply> {
    const rel = parseNotePath(request.path);
    if (rel === null) {
      return badPath();
    }
    const root = await this.vaultRoot();
    if (root === null) {
      return noVault();
    }
    if (!(await this.staysServed(root, rel))) {
      return badPath();
    }
    const abs = path.join(root, rel);
    if (await fsp.stat(abs).then(() => true, () => false)) {
      return failure('exists', 'a note with this name already exists');
    }
    const text = toLf(request.text ?? '');
    try {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST' || code === 'ENOTDIR') {
        return badPath();
      }
      throw error;
    }
    await atomicWrite(abs, text);
    return this.finish(root, rel, text, device, 'created');
  }

  private async finish(root: string, rel: string, text: string, device: string, what: string): Promise<{ ok: true; path: string; text: string; mtime: number }> {
    const mtime = await this.mtimeOf(path.join(root, rel));
    this.deps.log(`notes: ${device} ${what} ${rel}`);
    const change: NotesChange = { vaultPath: root, changed: [rel] };
    for (const listener of [...this.listeners]) {
      listener(change);
    }
    return { ok: true, path: rel, text, mtime };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work, work);
    this.writes = run.catch(() => undefined);
    return run;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async vaultRoot(): Promise<string | null> {
    const root = await this.deps.root();
    const isFolder = await fsp.stat(root).then((s) => s.isDirectory(), () => false);
    return isFolder ? root : null;
  }

  /**
   * The grammar judged the words the client sent; this judges where they
   * lead. A link inside the vault could point outside it or into `.drafts/`,
   * and the platform may read a name differently (`DRAFTS~1` on Windows), so
   * the deepest part that exists is resolved and judged again.
   */
  private async staysServed(root: string, rel: string): Promise<boolean> {
    const realRoot = await fsp.realpath(root);
    const missing: string[] = [];
    let probe = path.join(root, rel);
    for (;;) {
      try {
        const real = path.relative(realRoot, await fsp.realpath(probe));
        if (real === '..' || real.startsWith(`..${path.sep}`) || path.isAbsolute(real)) {
          return false;
        }
        const segments = real === '' ? [] : real.split(path.sep);
        return isServedPath([...segments, ...missing].join('/'));
      } catch (error) {
        if (!isMissing(error) || probe === root) {
          throw error;
        }
        missing.unshift(path.basename(probe));
        probe = path.dirname(probe);
      }
    }
  }

  private async readDisk(root: string, rel: string): Promise<{ text: string; mtime: number } | null> {
    const abs = path.join(root, rel);
    try {
      const text = toLf(await fsp.readFile(abs, 'utf8'));
      return { text, mtime: await this.mtimeOf(abs) };
    } catch (error) {
      if (isMissing(error) || errorCode(error) === 'EISDIR') {
        return null;
      }
      throw error;
    }
  }

  private async mtimeOf(abs: string): Promise<number> {
    return Math.round((await fsp.stat(abs)).mtimeMs);
  }

  private async entryOf(root: string, rel: string): Promise<NoteEntry | null> {
    const stat = await fsp.stat(path.join(root, rel)).catch(() => null);
    return stat === null ? null : { path: rel, name: nameOf(rel), mtime: Math.round(stat.mtimeMs), size: stat.size };
  }

  /** Links are not followed: a link in a listing could lead out of the vault. */
  private async allNotesNewestFirst(root: string): Promise<NoteEntry[]> {
    const notes: NoteEntry[] = [];
    const walk = async (folder: string): Promise<void> => {
      const entries = await fsp.readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!isServedChild(folder, entry.name)) {
          continue;
        }
        const rel = folder === '' ? entry.name : `${folder}/${entry.name}`;
        if (entry.isDirectory()) {
          await walk(rel);
        } else if (entry.isFile() && isNoteFileName(entry.name)) {
          const note = await this.entryOf(root, rel);
          if (note !== null) {
            notes.push(note);
          }
        }
      }
    };
    await walk('');
    return notes.sort((a, b) => b.mtime - a.mtime);
  }
}

/**
 * Temp file beside the target, flushed, renamed over it: a sync client or a
 * crash sees the old note or the new one, never half of it. The same steps
 * as Drey's `electron/safe-file.ts`, which the engine may not import. The
 * temp name starts with a dot, so nothing that lists notes sees it.
 */
async function atomicWrite(target: string, text: string): Promise<void> {
  const real = await fsp.realpath(target).catch(() => target);
  const existing = await fsp.stat(real).catch(() => null);
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    const handle = await fsp.open(tmp, 'wx', existing === null ? undefined : existing.mode & 0o777);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, real);
        return;
      } catch (error) {
        const delay = RENAME_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !TRANSIENT_RENAME_CODES.has(errorCode(error) ?? '')) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } catch {
    // A target another program keeps locked: a plain write still succeeds or reports why.
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    await fsp.writeFile(real, text, 'utf8');
  }
}
