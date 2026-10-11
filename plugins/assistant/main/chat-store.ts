/**
 * Vault IO for chat notes (ADR-0048): create, append, truncate, list.
 * Main-side only — it owns the `yaml`-based frontmatter patching (a
 * plugin renderer takes no package at runtime, and the patch must
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
  /**
   * Flat, forward-slash, `.md`-only vault paths (`ctx.vault.listMarkdownFiles`,
   * the same flat listing the tags/tasks/backlinks plugins scan) — chat
   * notes are always `.md`, and this is what every consumer here needs:
   * `ctx.vault.list()`'s nested tree was once filtered top-level-only,
   * silently emptying the picker (bug: `children` ignored).
   */
  listMarkdownFiles(): Promise<readonly string[]>;
  /**
   * Optional sink for chat files that drop from the picker (vanished or
   * unreadable between listing and read) — the field log makes the drop
   * visible instead of silently thinning the list.
   */
  log?(message: string, level?: 'info' | 'warn' | 'error'): void;
}

/** Frontmatter fields a chat turn append may bump. */
export interface ChatNotePatch {
  updated?: string;
  model?: string;
  session?: string | null;
  /** Rewrites the title (the model-named chat, 57e). */
  title?: string;
}

export class ChatNoteMissingError extends Error {
  constructor(path: string) {
    super(`Chat note not found: ${path}`);
    this.name = 'ChatNoteMissingError';
  }
}

export class ChatStore {
  /** Per-note write serialization (57e): a late title write must never revert a turn that landed meanwhile. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly ports: ChatStorePorts) {}

  private enqueue<T>(path: string, op: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(path) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    this.queues.set(path, next);
    void next.finally(() => {
      if (this.queues.get(path) === next) {
        this.queues.delete(path);
      }
    });
    return next;
  }

  /**
   * The path for a new chat: date + slug of the first question, uniqued
   * against the current `chats/` siblings. Returns the path and the
   * initial note text (frontmatter fence, no turns yet). `noteKey` — the
   * focused document's doc key (`vaultId::relativePath`) — is written as
   * the chat's `note:` binding when present (req: the panel follows the
   * active document).
   */
  async create(
    now: Date,
    firstQuestion: string,
    provider: string,
    model: string | null,
    noteKey: string | null = null,
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
    if (noteKey !== null) {
      // Quoted: the `::` separator must not parse as a YAML mapping.
      doc.set('note', quotedScalar(noteKey));
    }
    doc.set('created', quotedScalar(toTimestamp(now)));
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
    await this.enqueue(path, async () => {
      const raw = await this.requireRaw(path);
      const next = appendTurnText(raw, turn);
      await this.ports.writeAnnounced(
        path,
        this.patchFrontmatter(next, { ...patch, updated: toTimestamp(now) }),
      );
    });
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
    await this.enqueue(path, async () => {
      const raw = await this.requireRaw(path);
      const next = appendEditOutcomeText(raw, outcome);
      await this.ports.writeAnnounced(
        path,
        this.patchFrontmatter(next, { updated: toTimestamp(now) }),
      );
    });
  }

  /**
   * Drops every turn from `turnIndex` on ("restart from here") and clears
   * the provider `session:` — the truncated history no longer matches the
   * provider-side session, so the next turn must full-replay.
   */
  async truncateFrom(path: string, turnIndex: number, now: Date = new Date()): Promise<void> {
    await this.enqueue(path, async () => {
      const raw = await this.requireRaw(path);
      const next = truncateFromText(raw, turnIndex);
      await this.ports.writeAnnounced(
        path,
        this.patchFrontmatter(next, { updated: toTimestamp(now), session: null }),
      );
    });
  }

  /**
   * Renames the chat (the model-written title, 57e) and bumps `updated:`
   * so the picker re-sorts. Announced — the change round refreshes the
   * picker list and the panel's head label.
   */
  async setTitle(path: string, title: string, now: Date = new Date()): Promise<void> {
    await this.enqueue(path, async () => {
      const raw = await this.requireRaw(path);
      await this.ports.writeAnnounced(
        path,
        this.patchFrontmatter(raw, { title, updated: toTimestamp(now) }),
      );
    });
  }

  /**
   * Chat notes for the picker, most recently updated first, capped.
   * Sorts on the frontmatter `updated:` read per file — chat notes are
   * few, and the read is cheap frontmatter-only work.
   */
  async listChats(cap = 50): Promise<ChatSummary[]> {
    const paths = (await this.ports.listMarkdownFiles()).filter((p) =>
      p.startsWith(`${CHATS_DIR}/`),
    );
    const summaries: ChatSummary[] = [];
    for (const path of paths) {
      try {
        const view = parseChatNote(await this.ports.read(path));
        summaries.push({
          path,
          title: view.frontmatter.title ?? path,
          updated: view.frontmatter.updated,
          note: view.frontmatter.note,
        });
      } catch (err) {
        // A vanished or unreadable file just drops from the picker — but
        // the drop lands in the field log instead of staying silent.
        this.ports.log?.(
          `chat:list skips ${path}: ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        );
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
    const existing = new Set(await this.ports.listMarkdownFiles());
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
    if (patch.title !== undefined) {
      // Quoted like at creation — titles carry spaces, colons, quotes.
      setScalar(doc, 'title', patch.title, true);
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
