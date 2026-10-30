/**
 * Refining a ticket from the remote (req-66 R5, ADR-0084): replace one or
 * more body sections and the header fields, append one Log line. Pure —
 * the board service reads, checks the revision, writes and commits.
 *
 * A section's body runs from its heading to the next heading of ANY
 * level, so `## Plan` never swallows its `### Acceptance criteria`. The
 * Log is append-only and never a refine target.
 */
import { createHash } from 'node:crypto';
import { splitFrontmatter } from '../../../shared/frontmatter';
import { patchHeaderFields, withLogLine, type HeaderPatch } from './ticket-files';

export const REFINE_SECTIONS = {
  description: { title: 'Description', level: 2 },
  plan: { title: 'Plan', level: 2 },
  acceptance: { title: 'Acceptance criteria', level: 3 },
} as const;

export type RefineSection = keyof typeof REFINE_SECTIONS;

export interface RefinePatch {
  readonly sections: Partial<Record<RefineSection, string>>;
  readonly header: HeaderPatch;
}

/** What a client saw: a short hash of the whole file text. */
export function revisionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

/** The body with one section's content replaced (or the section added). */
export function replaceSection(body: string, section: RefineSection, content: string): string {
  const { title, level } = REFINE_SECTIONS[section];
  const lines = body.split('\n');
  const block = ['', ...content.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n'), ''];
  const isHeading = (line: string): boolean => HEADING.test(line);
  const at = lines.findIndex((line) => {
    const m = HEADING.exec(line);
    return m !== null && m[1]!.length >= 2 && m[1]!.length <= 3 && m[2]!.toLowerCase() === title.toLowerCase();
  });
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && !isHeading(lines[end]!)) {
      end++;
    }
    return [...lines.slice(0, at + 1), ...block, ...lines.slice(end)].join('\n');
  }
  // Missing: Acceptance criteria goes at the end of Plan's own body; the
  // rest before the Log (or at the end).
  let insertAt = -1;
  if (section === 'acceptance') {
    const plan = lines.findIndex((line) => /^##\s+Plan\s*$/i.test(line));
    if (plan >= 0) {
      insertAt = plan + 1;
      while (insertAt < lines.length && !isHeading(lines[insertAt]!)) {
        insertAt++;
      }
    }
  }
  if (insertAt < 0) {
    insertAt = lines.findIndex((line) => /^##\s+Log\s*$/i.test(line));
  }
  const heading = `${'#'.repeat(level)} ${title}`;
  if (insertAt < 0) {
    const trimmed = body.replace(/\s+$/, '');
    return `${trimmed}${trimmed === '' ? '' : '\n\n'}${heading}\n${block.join('\n')}`;
  }
  const before = lines.slice(0, insertAt);
  while (before.length > 0 && before[before.length - 1]!.trim() === '') {
    before.pop();
  }
  return [...before, '', heading, ...block, ...lines.slice(insertAt)].join('\n');
}

/** The refined file: header fields, sections, then one Log line naming what changed. */
export function refineTicket(text: string, patch: RefinePatch, actor: string, now: Date): string {
  const { yamlText, body, hadFence } = splitFrontmatter(text);
  if (!hadFence || yamlText === null) {
    throw new Error('ticket has no frontmatter fence');
  }
  const changed: string[] = [];
  let block = `---\n${yamlText}\n---`;
  if (Object.keys(patch.header).length > 0) {
    block = patchHeaderFields(block, patch.header);
    changed.push(...Object.keys(patch.header));
  }
  let next = body;
  for (const key of Object.keys(REFINE_SECTIONS) as RefineSection[]) {
    const content = patch.sections[key];
    if (content !== undefined) {
      next = replaceSection(next, key, content);
      changed.push(REFINE_SECTIONS[key].title.toLowerCase());
    }
  }
  if (changed.length === 0) {
    throw new Error('nothing to refine');
  }
  return withLogLine(`${block}\n${next}`, now, actor, `refined (${changed.join(', ')})`);
}
