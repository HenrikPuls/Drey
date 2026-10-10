/**
 * Rich card bodies for the chat (SDK 1.11): a deliberately small
 * Markdown subset — paragraphs, `-`/`*` bullet lists, `1.` ordered lists,
 * `**bold**`, `*italic*`, `` `code` `` — composed with `[[wikilinks]]`
 * from the base-owned `api.links` grammar. Everything becomes DOM nodes
 * (never `innerHTML`): model output is untrusted text.
 *
 * Wikilinks render as buttons with a sync resolve probe for styling
 * (resolved = accent, unresolved = muted dotted) and editor click
 * semantics: `api.links.open` follows the target — or CREATES the note.
 * A same-file `[[#anchor]]` (no target) has nothing to navigate to from
 * a chat, so it stays plain text.
 */
import type { DreyPluginApi, InlineSegment } from '../../../shared/plugin-api/renderer';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/**
 * One inline formatting pass over a plain-text run: `code` spans first,
 * then bold, then italic — one combined scan, non-nested (the model's
 * answers use exactly these shapes).
 */
const INLINE_FORMAT = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_/g;

type FormatSpan =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string };

export function parseInlineFormatting(text: string): FormatSpan[] {
  const spans: FormatSpan[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_FORMAT)) {
    const index = match.index;
    if (index > cursor) {
      spans.push({ kind: 'text', text: text.slice(cursor, index) });
    }
    if (match[1] !== undefined) {
      spans.push({ kind: 'code', text: match[1] });
    } else if (match[2] !== undefined) {
      spans.push({ kind: 'bold', text: match[2] });
    } else if (match[3] !== undefined) {
      spans.push({ kind: 'italic', text: match[3] });
    } else if (match[4] !== undefined) {
      spans.push({ kind: 'italic', text: match[4] });
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    spans.push({ kind: 'text', text: text.slice(cursor) });
  }
  return spans;
}

/** The nodes for one plain-text run: formatting spans become styled elements. */
function formatNodes(api: DreyPluginApi, text: string): Node[] {
  const nodes: Node[] = [];
  for (const span of parseInlineFormatting(text)) {
    if (span.kind === 'text') {
      nodes.push(...pathLinkNodes(api, span.text));
    } else if (span.kind === 'code') {
      nodes.push(el('code', 'inline-code', span.text));
    } else if (span.kind === 'bold') {
      nodes.push(el('strong', undefined, span.text));
    } else {
      nodes.push(el('em', undefined, span.text));
    }
  }
  return nodes;
}

/**
 * Vault-path mentions (`daily/2026/09/x.md`, at least one slash so a bare
 * file name stays prose) become buttons when they resolve — deterministic
 * source links even when the model writes plain paths instead of
 * wikilinks. Unresolved names stay text (never minted from prose).
 */
const VAULT_PATH = /(?:^|[\s(])((?:[\p{L}\p{N}_.\-]+\/)+[\p{L}\p{N}_.\-]+\.md)(?=$|[\s).,;:!?])/gu;

function pathLinkNodes(api: DreyPluginApi, text: string): Node[] {
  const nodes: Node[] = [];
  let cursor = 0;
  for (const match of text.matchAll(VAULT_PATH)) {
    const path = match[1];
    const start = match.index + match[0].length - path.length;
    if (start > cursor) {
      nodes.push(document.createTextNode(text.slice(cursor, start)));
    }
    const resolved = api.links.resolve(path);
    if (resolved === null) {
      nodes.push(document.createTextNode(path));
    } else {
      const button = el('button', 'chat-link');
      button.type = 'button';
      button.textContent = path;
      button.title = `${path} — click to open`;
      button.addEventListener('click', () => {
        void api.documents.open(resolved.path, undefined, { vaultId: resolved.vaultId });
      });
      nodes.push(button);
    }
    cursor = start + path.length;
  }
  if (cursor < text.length) {
    nodes.push(document.createTextNode(text.slice(cursor)));
  }
  return nodes;
}

/** One `[[…]]` as a button — or plain text for a same-file anchor. */
function wikilinkNode(api: DreyPluginApi, segment: Extract<InlineSegment, { kind: 'wikilink' }>): Node {
  if (segment.target === '') {
    return document.createTextNode(segment.alias ?? `[[#${segment.anchor ?? ''}]]`);
  }
  const button = el('button', 'chat-link');
  button.type = 'button';
  button.textContent = segment.alias ?? segment.target;
  const resolved = api.links.resolve(segment.target);
  if (resolved === null) {
    button.classList.add('unresolved');
    button.title = `[[${segment.target}${segment.anchor !== null ? `#${segment.anchor}` : ''}]] — no note matches, click creates one`;
  } else {
    button.title = `[[${segment.target}${segment.anchor !== null ? `#${segment.anchor}` : ''}]]`;
  }
  button.addEventListener('click', () => {
    void api.links.open(segment.target, segment.anchor);
  });
  return button;
}

/** The nodes for any text: wikilinks split first, formatting inside the runs. */
function inlineNodes(api: DreyPluginApi, text: string): Node[] {
  const nodes: Node[] = [];
  for (const segment of api.links.parseInline(text)) {
    if (segment.kind === 'wikilink') {
      nodes.push(wikilinkNode(api, segment));
    } else {
      nodes.push(...formatNodes(api, segment.text));
    }
  }
  return nodes;
}

const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const ORDERED = /^[ \t]*\d+[.)][ \t]+(.*)$/;

/**
 * The card body for one chat turn: block-level Markdown (paragraphs,
 * lists) over the inline pass. Replaces the plain `textContent` body.
 */
export function renderRichBody(api: DreyPluginApi, text: string): HTMLElement {
  const root = el('div', 'card-body');
  const lines = text.split('\n');
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) {
      return;
    }
    const p = el('p');
    for (const node of inlineNodes(api, paragraph.join('\n'))) {
      p.appendChild(node);
    }
    root.appendChild(p);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list === null) {
      return;
    }
    const listEl = list.ordered ? el('ol') : el('ul');
    for (const item of list.items) {
      const li = el('li');
      for (const node of inlineNodes(api, item)) {
        li.appendChild(node);
      }
      listEl.appendChild(li);
    }
    root.appendChild(listEl);
    list = null;
  };

  for (const line of lines) {
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      flushParagraph();
      const item = (bullet ?? ordered)![1];
      if (list === null || list.ordered !== (ordered !== null)) {
        flushList();
        list = { ordered: ordered !== null, items: [] };
      }
      list.items.push(item);
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return root;
}
