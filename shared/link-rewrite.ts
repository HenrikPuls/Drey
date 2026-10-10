import { normalizeRelative, resolveAssetRef } from './asset-refs';
import { NOTE_FILE, buildNoteIndex, extractWikilinks, resolveNoteTarget } from './wikilinks';
import type { NoteIndex } from './wikilinks';

/**
 * Link integrity across a rename / move (milestone 59, ADR-0059). Pure:
 * given the vault's file list, the note contents and one `from -> to`
 * rename, it plans which links must change and which attachments travel
 * along -- the main process (`electron/link-rewriter.ts`) feeds it and
 * carries the plan out.
 *
 * The rule is "what did this reference open BEFORE, and does the unchanged
 * text still open that AFTER?". Only a reference whose answer changes is
 * rewritten -- so a moved note keeps `[[Note]]` while its name stays unique,
 * and a rename rewrites exactly the links the editor would have followed.
 *
 * Attachments (images, PDFs, any non-note file a note embeds or links):
 * when a note changes folder, a file referenced relative to that note and
 * by nothing outside the move travels WITH it, link text untouched. A file
 * other notes use too stays put and the moved note's reference is
 * rewritten instead. Across vaults there is nothing to rewrite to, so the
 * exclusive file moves and a shared one is copied.
 *
 * Scanning mirrors the editor's guards: YAML frontmatter, fenced blocks
 * and inline code never yield references.
 */

/** One note's rewritten content. `path` is the note's path BEFORE the rename. */
export interface LinkPatch {
  path: string;
  newPath: string;
  before: string;
  after: string;
  /** References rewritten in this note. */
  links: number;
}

/** An attachment that travels with its note. Paths are vault-relative. */
export interface AssetMove {
  kind: 'move' | 'copy';
  from: string;
  to: string;
}

export interface RenamePlan {
  patches: LinkPatch[];
  assets: AssetMove[];
}

export interface RenamePlanInput {
  /** Every file in the source vault before the rename (vault-relative). */
  files: readonly string[];
  fromRel: string;
  toRel: string;
  /** Note contents by path before the rename, `\n` line endings. */
  contents: ReadonlyMap<string, string>;
  /**
   * The TARGET vault's files for a cross-vault move; absent within one
   * vault. Wikilinks are vault-scoped, so a cross-vault plan carries no
   * patches -- only the attachments that follow the moved notes.
   */
  targetFiles?: readonly string[];
}

const FRONTMATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;

/** Same-length copy of `content` with frontmatter and code blanked out. */
export function maskNonText(content: string): string {
  const blank = (m: string): string => ' '.repeat(m.length);
  return content
    .replace(FRONTMATTER, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/~~~[\s\S]*?~~~/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

type AssetRefKind = 'md' | 'md-angle' | 'wiki' | 'html';

interface AssetRef {
  /** Span of the reference's path text within the content. */
  from: number;
  to: number;
  url: string;
  kind: AssetRefKind;
}

const MD_LINK = /!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+[^)\n]*)?\)/g;
const WIKI_EMBED = /!\[\[([^\[\]#|\n]+)(?:[#|][^\[\]\n]*)?\]\]/g;
const HTML_IMG = /<img\b[^>\n]*?\bsrc\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/gi;

/** `![alt](url)`, `[text](url)`, `![[file]]` and `<img src>` references, in document order. */
function scanAssetRefs(masked: string): AssetRef[] {
  const out: AssetRef[] = [];
  const add = (matchIndex: number, whole: string, raw: string, kind: AssetRefKind, after: number): void => {
    const at = whole.indexOf(raw, after);
    const lead = raw.length - raw.trimStart().length;
    const url = raw.trim();
    if (at === -1 || url === '' || url.startsWith('#')) {
      return;
    }
    const from = matchIndex + at + lead;
    out.push({ from, to: from + url.length, url, kind });
  };
  for (const m of masked.matchAll(MD_LINK)) {
    const open = m[0].indexOf('](') + 2;
    if (m[1] !== undefined) {
      add(m.index, m[0], m[1], 'md-angle', open);
    } else if (m[2] !== undefined) {
      add(m.index, m[0], m[2], 'md', open);
    }
  }
  for (const m of masked.matchAll(WIKI_EMBED)) {
    add(m.index, m[0], m[1], 'wiki', 3);
  }
  for (const m of masked.matchAll(HTML_IMG)) {
    const raw = m[1] ?? m[2] ?? '';
    add(m.index, m[0], raw, 'html', m[0].search(/\bsrc\s*=/i));
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Case-insensitive file set (vault paths compare like the OS does on Windows / macOS). */
class FileSet {
  private readonly byKey = new Map<string, string>();

  constructor(paths: readonly string[]) {
    for (const path of paths) {
      this.add(path);
    }
  }

  add(path: string): void {
    this.byKey.set(path.toLowerCase(), path);
  }

  delete(path: string): void {
    this.byKey.delete(path.toLowerCase());
  }

  has(path: string): boolean {
    return this.byKey.has(path.toLowerCase());
  }

  /** The real-case path, or null. */
  get(path: string): string | null {
    return this.byKey.get(path.toLowerCase()) ?? null;
  }
}

function dirOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function same(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

/** The first candidate of the shared asset chain that exists in `files`. */
function resolveAsset(docPath: string, url: string, files: FileSet): string | null {
  const ref = resolveAssetRef(docPath, url);
  if (ref.kind !== 'vault') {
    return null;
  }
  for (const candidate of ref.candidates) {
    const hit = files.get(candidate);
    if (hit !== null) {
      return hit;
    }
  }
  return null;
}

function decoded(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Where an attachment found relative to its note belongs once the note
 * lives at `newNote` -- the same offset from the new folder. `null` when
 * the reference did not resolve note-relative (a vault-root path keeps
 * resolving from anywhere) or would leave the vault.
 */
function travelTarget(oldNote: string, newNote: string, url: string, asset: string): string | null {
  const oldDir = dirOf(oldNote);
  const newDir = dirOf(newNote);
  const join = (dir: string, rel: string): string | null =>
    normalizeRelative(dir !== '' ? `${dir}/${rel}` : rel);
  for (const u of url === decoded(url) ? [url] : [url, decoded(url)]) {
    if (same(join(oldDir, u), asset)) {
      return join(newDir, u);
    }
    if (!u.includes('/') && same(join(oldDir, `attachments/${u}`), asset)) {
      return join(newDir, `attachments/${u}`);
    }
  }
  return null;
}

/** `to` as seen from the folder `fromDir` (`../` steps where needed). */
export function relativePath(fromDir: string, to: string): string {
  const a = fromDir === '' ? [] : fromDir.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i].toLowerCase() === b[i].toLowerCase()) {
    i++;
  }
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

function assetLinkText(asset: string, note: string, kind: AssetRefKind): string {
  if (kind === 'wiki') {
    return asset;
  }
  const rel = relativePath(dirOf(note), asset);
  return kind === 'md'
    ? rel.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')
    : rel;
}

/**
 * The text that makes a wikilink in `note` open `target`: the bare name
 * when the original was a bare name and the name still resolves there,
 * else the extension-less path, else the full path.
 */
function noteLinkText(target: string, note: string, notes: NoteIndex, original: string): string {
  const keepExt = /\.[^/]+$/.test(original) || !/\.md$/i.test(target);
  const path = keepExt ? target : target.replace(/\.md$/i, '');
  if (!original.includes('/')) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (resolveNoteTarget(name, note, notes) === target) {
      return name;
    }
  }
  return resolveNoteTarget(path, note, notes) === target ? path : target;
}

interface Edit {
  from: number;
  to: number;
  text: string;
}

function applyEdits(content: string, edits: readonly Edit[]): string {
  let out = content;
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, edit.from) + edit.text + out.slice(edit.to);
  }
  return out;
}

/** Plans the link rewrites and attachment moves for one rename / move. */
export function planRename(input: RenamePlanInput): RenamePlan {
  const { files, fromRel, toRel, contents } = input;
  const prefix = `${fromRel}/`;
  const remap = (path: string): string =>
    path === fromRel ? toRel : path.startsWith(prefix) ? toRel + path.slice(fromRel.length) : path;
  const isMoved = (path: string): boolean => path === fromRel || path.startsWith(prefix);

  const oldFiles = new FileSet(files);
  const notes = files.filter((p) => NOTE_FILE.test(p));
  const crossVault = input.targetFiles !== undefined;
  const newFiles = crossVault
    ? new FileSet([...input.targetFiles!, ...files.filter(isMoved).map(remap)])
    : new FileSet(files.map(remap));

  // Each note's references, masked once.
  const scanned = new Map<string, { content: string; masked: string; refs: AssetRef[] }>();
  // Which notes reference each attachment -- "exclusive" is read off this.
  const users = new Map<string, Set<string>>();
  for (const note of notes) {
    const content = contents.get(note);
    if (content === undefined) {
      continue;
    }
    const masked = maskNonText(content);
    const refs = scanAssetRefs(masked);
    scanned.set(note, { content, masked, refs });
    for (const ref of refs) {
      const asset = resolveAsset(note, ref.url, oldFiles);
      if (asset !== null) {
        const key = asset.toLowerCase();
        let set = users.get(key);
        if (set === undefined) {
          set = new Set<string>();
          users.set(key, set);
        }
        set.add(note);
      }
    }
  }
  const exclusive = (asset: string): boolean =>
    [...(users.get(asset.toLowerCase()) ?? [])].every(isMoved);

  const assets: AssetMove[] = [];
  const travelled = new Map<string, string>();
  const travel = (kind: 'move' | 'copy', from: string, to: string): void => {
    assets.push({ kind, from, to });
    travelled.set(from.toLowerCase(), to);
    if (!crossVault && kind === 'move') {
      newFiles.delete(from);
    }
    newFiles.add(to);
  };

  if (crossVault) {
    for (const note of notes.filter(isMoved)) {
      const entry = scanned.get(note);
      for (const ref of entry?.refs ?? []) {
        const asset = resolveAsset(note, ref.url, oldFiles);
        if (asset === null || isMoved(asset) || NOTE_FILE.test(asset) || travelled.has(asset.toLowerCase())) {
          continue;
        }
        // A vault-root reference keeps its path in the other vault.
        const target = travelTarget(note, remap(note), ref.url, asset) ?? asset;
        if (!newFiles.has(target)) {
          travel(exclusive(asset) ? 'move' : 'copy', asset, target);
        }
      }
    }
    return { patches: [], assets };
  }

  const oldNotes = buildNoteIndex(notes);
  const newNotes = buildNoteIndex(notes.map(remap));
  const patches: LinkPatch[] = [];

  // Moved notes first: their attachments decide what travels before the
  // notes that stay are checked against the resulting layout.
  const order = [...notes.filter(isMoved), ...notes.filter((n) => !isMoved(n))];
  for (const note of order) {
    const entry = scanned.get(note);
    if (entry === undefined) {
      continue;
    }
    const newNote = remap(note);
    const edits: Edit[] = [];

    for (const occ of extractWikilinks(entry.masked)) {
      if (occ.target === '') {
        continue;
      }
      const before = resolveNoteTarget(occ.target, note, oldNotes);
      if (before === null) {
        continue;
      }
      const want = remap(before);
      if (resolveNoteTarget(occ.target, newNote, newNotes) === want) {
        continue;
      }
      const from = occ.index + 2;
      edits.push({
        from,
        to: from + occ.rawTargetLength,
        text: noteLinkText(want, newNote, newNotes, occ.target),
      });
    }

    for (const ref of entry.refs) {
      const asset = resolveAsset(note, ref.url, oldFiles);
      // A wikilink embed of a NOTE is the wikilink pass's business.
      if (asset === null || (ref.kind === 'wiki' && NOTE_FILE.test(asset))) {
        continue;
      }
      let want = travelled.get(asset.toLowerCase()) ?? remap(asset);
      if (
        isMoved(note) &&
        !isMoved(asset) &&
        !travelled.has(asset.toLowerCase()) &&
        !NOTE_FILE.test(asset) &&
        exclusive(asset)
      ) {
        const target = travelTarget(note, newNote, ref.url, asset);
        if (target !== null && !same(target, asset) && !newFiles.has(target)) {
          travel('move', asset, target);
          want = target;
        }
      }
      if (same(resolveAsset(newNote, ref.url, newFiles), want)) {
        continue;
      }
      edits.push({ from: ref.from, to: ref.to, text: assetLinkText(want, newNote, ref.kind) });
    }

    if (edits.length > 0) {
      const after = applyEdits(entry.content, edits);
      if (after !== entry.content) {
        patches.push({ path: note, newPath: newNote, before: entry.content, after, links: edits.length });
      }
    }
  }

  patches.sort((a, b) => a.newPath.localeCompare(b.newPath));
  return { patches, assets };
}
