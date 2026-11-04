/**
 * The `## Verification` section's writer and reader (E4, ADR-0088 later
 * change). The verify service replaces the section after every run; the
 * proof card reads it back tolerantly. Machine writes are strict — the
 * exact shapes below; the reader forgives (the asymmetric-tolerance
 * rule, ADR-0076): an absent or partially unreadable section simply
 * means "not verified yet", never a guess.
 *
 * The canonical shape (specs/ticket-schema.md):
 *
 *     ## Verification
 *
 *     Tested on 2026-11-01T14:32:00Z by verify@engine — Electron 34.2.0 on win32.
 *
 *     ### Criteria
 *
 *     - [x] `npm run build` → ![](../attachments/verify-20261101-143200-01.png)
 *     - [ ] `npm test` — no screenshot: the app never became ready
 *
 *     ### Findings
 *
 *     - The settings page stayed blank until the reload.
 *
 * The screenshot link is relative from `tickets/<phase>/<id>.md`, so
 * `../attachments/<name>` resolves to the vault's `tickets/attachments/`.
 */
import { maskFences } from '../../../../shared/markdown/fences';
import type { VerificationCriterionProof, VerificationReport, VideoChapter } from '../contracts/verify';

export const VERIFICATION_HEADING = '## Verification';

/** Renders the whole section including the heading; ends with one `\n`. */
export function renderVerificationSection(report: VerificationReport): string {
  const lines: string[] = [VERIFICATION_HEADING, ''];
  const who = report.tester.trim() === '' ? 'verify' : report.tester;
  lines.push(
    report.environment.trim() === ''
      ? `Tested on ${report.testedAt} by ${who}.`
      : `Tested on ${report.testedAt} by ${who} — ${report.environment}.`,
    '',
    '### Criteria',
    '',
  );
  for (const criterion of report.criteria) {
    let line = `- [${criterion.passed ? 'x' : ' '}] \`${criterion.command}\``;
    if (criterion.screenshot !== null) {
      line += ` → ![](../attachments/${criterion.screenshot})`;
    }
    if (criterion.note !== null && criterion.note.trim() !== '') {
      line += ` — ${criterion.note}`;
    }
    lines.push(line);
  }
  if (report.video !== undefined && report.video !== null) {
    lines.push('', '### Video', '', `![](../videos/${report.video})`);
    const chapters = report.videoChapters ?? [];
    if (chapters.length > 0) {
      lines.push('');
      for (const chapter of chapters) {
        lines.push(`- ${formatOffset(chapter.atMs)} ${chapter.label}`);
      }
    }
  } else if (report.videoRemoved === true) {
    lines.push('', '### Video', '', VIDEO_REMOVED_NOTE);
  }
  if (report.findings.length > 0) {
    lines.push('', '### Findings', '');
    for (const finding of report.findings) {
      lines.push(`- ${finding}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reads the section back; null when the heading is absent. Partially
 * unreadable parts degrade to defaults (an empty stamp, a note lost) —
 * the proof card shows what the file actually says.
 */
export function parseVerificationSection(text: string): VerificationReport | null {
  const raw = sectionText(text);
  if (raw === null) {
    return null;
  }
  // A fence inside the section hides its lines from the stamp, the
  // criteria, the findings and the video chapter alike.
  const section = maskFences(raw);
  const tested = /^Tested on (\S+) by ([^—]+?)(?: — (.+?))?\.?$/m.exec(section);
  const criteria: VerificationCriterionProof[] = [];
  const criterionRe = /^- \[([ xX])\] `([^`]+)`(?: → !\[\]\(\.\.\/attachments\/([^)]+)\))?(?: — (.+))?$/gm;
  for (let match = criterionRe.exec(section); match !== null; match = criterionRe.exec(section)) {
    criteria.push({
      command: match[2]!,
      passed: match[1]!.toLowerCase() === 'x',
      screenshot: match[3] ?? null,
      note: match[4] ?? null,
    });
  }
  const findings: string[] = [];
  const findingsAt = section.indexOf('### Findings');
  if (findingsAt >= 0) {
    const tail = section.slice(findingsAt);
    for (const line of tail.split('\n')) {
      const match = /^- (.+)$/.exec(line.trim());
      if (match !== null) {
        findings.push(match[1]!);
      }
    }
  }
  const video = parseVideoChapter(section);
  return {
    testedAt: tested?.[1] ?? '',
    tester: tested?.[2]?.trim() ?? '',
    environment: tested?.[3]?.trim() ?? '',
    criteria,
    findings,
    ...video,
  };
}

/**
 * Replaces the section, or inserts it before `## Log` (else appends at
 * the end). The replacement owns only its own block — everything before
 * and after survives byte-identical apart from the one blank line the
 * section keeps before a following heading.
 */
export function upsertVerificationSection(fileText: string, section: string): string {
  const normalized = section.endsWith('\n') ? section : `${section}\n`;
  const current = boundsOf(fileText);
  if (current !== null) {
    const before = fileText.slice(0, current.start);
    const after = fileText.slice(current.end).replace(/^\n+/, '');
    return after === '' ? `${before}${normalized}` : `${before}${normalized}\n${after}`;
  }
  const logAt = /^## Log$/m.exec(maskFences(fileText));
  if (logAt !== null) {
    return `${fileText.slice(0, logAt.index)}${normalized}\n${fileText.slice(logAt.index)}`;
  }
  return `${fileText.replace(/\n*$/, '')}\n\n${normalized}`;
}

/** The note that replaces the player once the size limit freed the video. */
export const VIDEO_REMOVED_NOTE = 'Video removed (size limit).';

function formatOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The `### Video` chapter's pieces; empty when the chapter is absent. */
function parseVideoChapter(section: string): { video?: string; videoRemoved?: boolean; videoChapters?: VideoChapter[] } {
  const at = section.indexOf('### Video');
  if (at < 0) {
    return {};
  }
  const rest = section.slice(at + '### Video'.length);
  const end = /^### /m.exec(rest);
  const body = end === null ? rest : rest.slice(0, end.index);
  const player = /!\[\]\(\.\.\/videos\/([^)]+)\)/.exec(body);
  if (player === null) {
    return body.includes(VIDEO_REMOVED_NOTE) ? { videoRemoved: true } : {};
  }
  const videoChapters: VideoChapter[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^- (\d+):(\d{2}) (.+)$/.exec(line.trim());
    if (match !== null) {
      videoChapters.push({ atMs: (Number(match[1]) * 60 + Number(match[2])) * 1000, label: match[3]! });
    }
  }
  return { video: player[1]!, ...(videoChapters.length > 0 ? { videoChapters } : {}) };
}

/** The section's text without the heading's neighbours; null when absent. */
function sectionText(text: string): string | null {
  const bounds = boundsOf(text);
  return bounds === null ? null : text.slice(bounds.start, bounds.end);
}

/** [start, end) of the `## Verification` block — end at the next H2 or EOF. */
function boundsOf(text: string): { start: number; end: number } | null {
  const scan = maskFences(text);
  const heading = /^## Verification$/m.exec(scan);
  if (heading === null) {
    return null;
  }
  const rest = scan.slice(heading.index);
  const next = /^## /gm.exec(rest.slice('## Verification'.length));
  const end = next === null ? text.length : heading.index + '## Verification'.length + next.index;
  return { start: heading.index, end };
}
