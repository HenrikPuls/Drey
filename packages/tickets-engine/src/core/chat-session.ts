/**
 * The chat session files' writer and reader (E5a, ADR-0088 later
 * change): one session = one Markdown file under `tickets/_meta/chat/`,
 * openable in Drey's editor like any other note. Machine writes are
 * strict — the exact line shapes below; the reader forgives (the
 * asymmetric-tolerance rule, ADR-0076): an unreadable line is skipped,
 * never a guess. The canonical format is documented in
 * specs/ticket-schema.md.
 *
 *     ---
 *     title: "Costs export"
 *     created: '2026-11-02T09:00:00Z'
 *     ---
 *
 *     - '2026-11-02T09:01:00Z' owner — Move T-0086 to review
 *     - '2026-11-02T09:01:12Z' thought — The owner wants T-0086 moved …
 *     - '2026-11-02T09:01:44Z' mission — Done. T-0086 sits in review now.
 *     - '2026-11-02T09:01:44Z' proposal p-1 pending — Move T-0086 from build to review
 *       ```json
 *       {"kind":"transition","id":"T-0086","from":"build","to":"review"}
 *       ```
 *     - '2026-11-02T09:02:10Z' proposal p-1 confirmed — Move T-0086 from build to review → ok
 */
import { splitFrontmatter } from '../../../../shared/frontmatter';
import { DEFAULT_PRIORITY_CONFIG, type PriorityConfig } from '../contracts/tickets';
import type { ChatCommand, ChatMessage, ChatProposal, ChatSession } from '../contracts/chat';
import { validateChatCommand } from './chat-intents';

export const CHAT_DIR = 'tickets/_meta/chat';

/** `<stamp>-<slug>.md` — the stamp keeps names unique, the slug readable. */
export function chatFileName(now: Date, title: string): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${String(now.getUTCFullYear())}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${stamp}-${sessionSlug(title)}.md`;
}

/** Lowercase `[a-z0-9-]` slug, cut on a word boundary; `chat` when empty. */
export function sessionSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'chat' : slug;
}

/** The strict canonical shape of a fresh session file. */
export function newSessionText(title: string, now: Date, ticket?: string): string {
  const stamp = now.toISOString();
  const name = title.trim() === '' ? 'Chat' : title.trim();
  const shaped = ticket !== undefined && /^T-\d{4,}$/.test(ticket) ? `ticket: ${ticket}\n` : '';
  return `---\ntitle: "${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\ncreated: '${stamp}'\n${shaped}---\n\n`;
}

/** Appends the "You edited the plan" card: the summary line and the fenced diff the model read. */
export function appendPlanEdit(text: string, now: Date, summary: string, diff: string): string {
  const base = text.endsWith('\n') ? text : `${text}\n`;
  const body = diff.split('\n').map((line) => `  ${line}`).join('\n');
  return `${base}- '${now.toISOString()}' plan-edit — ${summary}\n  \`\`\`diff\n${body}\n  \`\`\`\n`;
}

export function appendOwner(text: string, now: Date, message: string): string {
  return `${text.endsWith('\n') ? text : `${text}\n`}- '${now.toISOString()}' owner — ${message}\n`;
}

/** Appends the thinking trace (when there is one) and the mission reply. */
export function appendMission(text: string, now: Date, say: string, thought: string | null): string {
  const base = text.endsWith('\n') ? text : `${text}\n`;
  const think = thought !== null && thought.trim() !== '' ? `- '${now.toISOString()}' thought — ${thought.trim()}\n` : '';
  return `${base}${think}- '${now.toISOString()}' mission — ${say}\n`;
}

/** Appends a pending proposal line with its command block; returns the minted id. */
export function appendProposal(
  text: string,
  now: Date,
  summary: string,
  command: ChatCommand,
): { readonly text: string; readonly id: string } {
  const id = nextProposalId(text);
  const base = text.endsWith('\n') ? text : `${text}\n`;
  return {
    id,
    text:
      `${base}- '${now.toISOString()}' proposal ${id} pending — ${summary}\n` +
      `  \`\`\`json\n  ${JSON.stringify(command)}\n  \`\`\`\n`,
  };
}

/** Appends the decision line; null when no such pending proposal exists. */
export function decideProposal(
  text: string,
  now: Date,
  id: string,
  state: 'confirmed' | 'dismissed',
  outcome: string | null,
): string | null {
  if (!hasPendingProposal(text, id)) {
    return null;
  }
  const pending = findPendingSummary(text, id);
  const tail = outcome !== null && outcome.trim() !== '' ? ` → ${outcome.trim()}` : '';
  const line = `- '${now.toISOString()}' proposal ${id} ${state} — ${pending}${tail}\n`;
  return `${text.endsWith('\n') ? text : `${text}\n`}${line}`;
}

/** Reads a session file back; null when the frontmatter is unreadable.
 *  `priorities` is the board's vocabulary — a proposal's priority field
 *  validates against it, so a custom-vocabulary card survives the file
 *  round-trip (the chat service passes the snapshot's config). */
export function parseSessionFile(
  text: string,
  file: string,
  priorities: PriorityConfig = DEFAULT_PRIORITY_CONFIG,
): ChatSession | null {
  const { yamlText, body, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    return null;
  }
  const title = /^title:\s*"(.*)"\s*$/m.exec(yamlText)?.[1] ?? /^title:\s*'?([^'\n]+)'?\s*$/m.exec(yamlText)?.[1] ?? 'Chat';
  const createdAt = /^created:\s*'([^']+)'/m.exec(yamlText)?.[1] ?? '';
  const messages: ChatMessage[] = [];
  const proposals: ChatProposal[] = [];
  let pendingThought: { at: string; text: string } | null = null;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const planEdit = /^- '([^']+)' plan-edit — (.*)$/.exec(line);
    if (planEdit !== null) {
      const diffLines: string[] = [];
      let j = i + 1;
      if (lines[j]?.trim() === '```diff') {
        for (j++; j < lines.length && lines[j]!.trim() !== '```'; j++) {
          diffLines.push(lines[j]!.replace(/^ {2}/, ''));
        }
        i = j;
      }
      messages.push({ role: 'owner', text: planEdit[2]!, at: planEdit[1]!, thought: null, kind: 'plan-edit', diff: diffLines.join('\n') });
      continue;
    }
    const basic = /^- '([^']+)' (owner|mission|thought) — (.*)$/.exec(line);
    if (basic !== null) {
      const [, at, role, payload] = basic;
      if (role === 'thought') {
        pendingThought = { at: at!, text: payload! };
      } else {
        messages.push({
          role: role as 'owner' | 'mission',
          text: payload!,
          at: at!,
          thought: pendingThought !== null && role === 'mission' ? pendingThought.text : null,
        });
        pendingThought = null;
      }
      continue;
    }
    const proposed = /^- '([^']+)' proposal (p-\d+) pending — (.*)$/.exec(line);
    if (proposed !== null) {
      const [, at, id, summary] = proposed;
      const block = lines
        .slice(i + 1, i + 4)
        .join('')
        .trim();
      const json = /^```json\s*(.+?)\s*```$/.exec(block)?.[1] ?? null;
      const command = json === null ? null : validateChatCommand(safeJson(json), priorities);
      if (command !== null) {
        proposals.push({ id: id!, state: 'pending', summary: summary!, command, at: at!, decidedAt: null, outcome: null });
      }
      continue;
    }
    const decided = /^- '([^']+)' proposal (p-\d+) (confirmed|dismissed) — (.*?)(?: → (.*))?$/.exec(line);
    if (decided !== null) {
      const [, at, id, state, summary, outcome] = decided;
      const existing = proposals.find((p) => p.id === id);
      if (existing !== undefined && existing.state === 'pending') {
        proposals[proposals.indexOf(existing)] = {
          ...existing,
          state: state as 'confirmed' | 'dismissed',
          summary: summary!,
          decidedAt: at!,
          outcome: outcome ?? null,
        };
      }
    }
  }
  const ticket = /^ticket:\s*(T-\d{4,})\s*$/m.exec(yamlText)?.[1] ?? null;
  return { file, title, createdAt, messages, proposals, ticket };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function nextProposalId(text: string): string {
  let max = 0;
  for (const match of text.matchAll(/proposal p-(\d+) pending/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return `p-${max + 1}`;
}

function hasPendingProposal(text: string, id: string): boolean {
  return new RegExp(`proposal ${id} pending`).test(text) && !new RegExp(`proposal ${id} (confirmed|dismissed)`).test(text);
}

function findPendingSummary(text: string, id: string): string {
  const match = new RegExp(`proposal ${id} pending — (.*)`).exec(text);
  return match?.[1]?.trim() ?? id;
}
