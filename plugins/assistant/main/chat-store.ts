/**
 * Vault IO for chat notes (ADR-0048): create, append, truncate, list.
 * Main-side only — it owns the `yaml`-based frontmatter patching (plugin
 * renderers cannot runtime-import app `shared/`, and the patch must
 * preserve every user-added key, so it mirrors `shared/frontmatter.ts`'s
 * targeted-node-mutation approach on the few chat fields).
 *
 * Every write goes through the announced write: a chat note is a
 * first-class vault file, so the Files tree, the tag index and any clean
 * open tab of it must see the change immediately (the watcher would only
 * suppress our own echo, and with the watcher off nothing else fires).
 * Ports are injected so the unit suite can drive this with an in-memory
 * vault.
 */
import { Document, Scalar, isScalar, parseDocument } from 'yaml';
import {
  CHATS_DIR,
  CHAT_KIND,
  ChatNoteTurn,
  ChatSummary,
  appendEditOutcome as appendEditOutcomeText,
  appendTurn as appendTurnText,
  chatNotePathFor,
  parseChatNote,
  slugifyChatTitle,
  truncateFrom as truncateFromText,
  uniqueChatPath,
} from '../shared/chat-note.js';

export interface ChatStorePorts {
  read(path: string): Promise<string>;
  writeAnnounced(path: string, content: string): Promise<unknown>;
  list(): Promise<readonly { name: string; relativePath: string; type: 'file' | 'directory' }[]>;
}

/** Frontmatter fields a chat turn append may bump. */
export interface ChatNotePatch {
  updated?: string;
  model?: string;
  session?: string | null;
}

export class ChatNoteMissingError extends Error {
  constructor(path: string) {
    super(`Chat note not found: ${path}`);
    this.name = 'ChatNoteMissingError';
  }
}

export class ChatStore {
  constructor(private readonly ports: ChatStorePorts) {}

  /**
   * The path for a new chat: date + slug of the first question, uniqued
   * against the current `chats/` siblings. Returns the path and the
   * initial note text (frontmatter fence, no turns yet).
   */
  async create(
    now: Date,
    firstQuestion: string,
    provider: string,
    model: string | null,
  ): Promise<{ path: string; content: string }> {
    const dateStr = toDateStr(now);
    const path = await this.freePath(dateStr, firstQuestion);
    const doc = new Document();
    doc.set('kind', plainScalar(CHAT_KIND));
    if (model !== null) {
      doc.set('model', plainScalar(model));
    }
    doc.set('provider', plainScalar(provider));
    doc.set('title', quotedScalar(firstTitle(firstQuestion)));
    doc.set('created', quotedScalar(toDateStr(now)));
    doc.set('updated', quotedScalar(toTimestamp(now)));
    let yaml = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
    if (!yaml.endsWith('\n')) {
      yaml += '\n';
    }
    return { path, content: `---\n${yaml}---\n` };
  }

  /** Writes the initial note and returns its path. */
  async save(path: string, content: string): Promise<void> {
    await this.ports.writeAnnounced(path, content);
  }

  async read(path: string) {
    return parseChatNote(await this.ports.read(path));
  }

  /** Appends a turn and bumps `updated:` (plus any given fields). */
  async appendTurn(
    path: string,
    turn: ChatNoteTurn,
    patch: ChatNotePatch = {},
    now: Date = new Date(),
  ): Promise<void> {
    const raw = await this.requireRaw(path);
    const next = appendTurnText(raw, turn);
    await this.ports.writeAnnounced(path, this.patchFrontmatter(next, { ...patch, updated: toTimestamp(now) }));
  }

  /**
   * Appends the edit outcome (applied + document / discarded) to the last
   * assistant turn's fence and bumps `updated:`.
   */
  async appendEditOutcome(
    path: string,
    outcome: { path: string; applied: boolean; after?: string },
    now: Date = new Date(),
  ): Promise<void> {
    const raw = await this.requireRaw(path);
    const next = appendEditOutcomeText(raw, outcome);
    await this.ports.writeAnnounced(
      path,
      this.patchFrontmatter(next, { updated: toTimestamp(now) }),
    );
  }

  /**
   * Drops every turn from `turnIndex` on ("restart from here") and clears
   * the provider `session:` — the truncated history no longer matches the
   * provider-side session, so the next turn must full-replay.
   */
  async truncateFrom(path: string, turnIndex: number, now: Date = new Date()): Promise<void> {
    const raw = await this.requireRaw(path);
    const next = truncateFromText(raw, turnIndex);
    await this.ports.writeAnnounced(
      path,
      this.patchFrontmatter(next, { updated: toTimestamp(now), session: null }),
    );
  }

  /**
   * Chat notes for the picker, most recently updated first, capped.
   * Sorts on the frontmatter `updated:` read per file — chat notes are
   * few, and the read is cheap frontmatter-only work.
   */
  async listChats(cap = 50): Promise<ChatSummary[]> {
    const entries = await this.ports.list();
    const paths = entries
      .filter((e) => e.type === 'file' && e.relativePath.startsWith(`${CHATS_DIR}/`))
      .map((e) => e.relativePath);
    const summaries: ChatSummary[] = [];
    for (const path of paths) {
      try {
        const view = parseChatNote(await this.ports.read(path));
        summaries.push({
          path,
          title: view.frontmatter.title ?? path,
          updated: view.frontmatter.updated,
        });
      } catch {
        // A vanished or unreadable file just drops from the picker.
      }
    }
    summaries.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
    return summaries.slice(0, cap);
  }

  // -- internals -----------------------------------------------------------

  private async requireRaw(path: string): Promise<string> {
    try {
      return await this.ports.read(path);
    } catch {
      throw new ChatNoteMissingError(path);
    }
  }

  private async freePath(dateStr: string, firstQuestion: string): Promise<string> {
    const entries = await this.ports.list();
    const existing = new Set(
      entries.filter((e) => e.type === 'file').map((e) => e.relativePath),
    );
    const base = chatNotePathFor(dateStr, slugifyChatTitle(firstQuestion));
    return uniqueChatPath(base, existing);
  }

  /**
   * Targeted frontmatter mutation on the chat fields — every other key
   * (and its style/comments) survives, exactly like `shared/frontmatter.ts`.
   */
  private patchFrontmatter(noteText: string, patch: ChatNotePatch): string {
    const fence = /^---\n([\s\S]*?)\n(---[ \t]*(?:\n|$))([\s\S]*)$/;
    const match = fence.exec(noteText);
    if (!match) {
      return noteText; // never add a header that wasn't there
    }
    const doc = parseDocument(match[1]);
    if (doc.errors.length > 0) {
      return noteText;
    }
    if (patch.updated !== undefined) {
      setScalar(doc, 'updated', patch.updated, true);
    }
    if (patch.model !== undefined) {
      setScalar(doc, 'model', patch.model, false);
    }
    if (patch.session === null) {
      // Cleared (truncate) — remove the key entirely rather than writing
      // `session: null` (the field is plugin-managed; absence is cleaner).
      if (doc.has('session')) {
        doc.delete('session');
      }
    } else if (patch.session !== undefined) {
      setScalar(doc, 'session', patch.session, false);
    }
    let yaml = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
    if (!yaml.endsWith('\n')) {
      yaml += '\n';
    }
    return `---\n${yaml}---\n${match[3]}`;
  }
}

/** First free-form line of the first question becomes the note title. */
function firstTitle(question: string): string {
  const line = (question ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '');
  return line ?? 'Chat';
}

function toDateStr(now: Date): string {
  const pad = (v: number): string => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function toTimestamp(now: Date): string {
  const pad = (v: number, n = 2): string => String(v).padStart(n, '0');
  return (
    `${toDateStr(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

function plainScalar(value: string): Scalar {
  const node = new Scalar(value);
  node.type = Scalar.PLAIN;
  return node;
}

function quotedScalar(value: string): Scalar {
  const node = new Scalar(value);
  node.type = Scalar.QUOTE_DOUBLE;
  return node;
}

function setScalar(doc: Document, key: string, value: string, quoted: boolean): void {
  const node = doc.get(key, true);
  if (isScalar(node)) {
    node.value = value;
    node.type = quoted ? Scalar.QUOTE_DOUBLE : Scalar.PLAIN;
    return;
  }
  doc.set(key, quoted ? quotedScalar(value) : plainScalar(value));
}
