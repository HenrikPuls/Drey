/**
 * The `## Report` section's writer and reader (E8, concept §5.6). A
 * scout run writes the section into its own ticket file; the engine's
 * "Needs you" derivation reads it back for the report card. Machine
 * writes are strict — the exact shapes below; the reader forgives (the
 * asymmetric-tolerance rule, ADR-0076): an absent or partially
 * unreadable section simply means "no report yet", never a guess.
 *
 * The canonical shape (specs/ticket-schema.md):
 *
 *     ## Report
 *
 *     Written on 2026-11-02T14:32:00Z by paul.
 *
 *     ### Summary
 *
 *     The repo carries two index implementations; only SQLite is wired
 *     into the build.
 *
 *     ### Decisions
 *
 *     - [ ] D1: Which storage should back the index? — Recommendation: SQLite, the repo already ships the helper.
 *     - [x] D2: Migrate existing data? — Recommendation: yes, one migration script.
 *
 * The section lives in the ticket file like every other chapter; the
 * writer replaces only its own block, so frontmatter, Log and
 * neighbouring chapters survive byte-identical.
 */
import type { ScoutDecision, ScoutReport } from '../contracts/scout';

export const SCOUT_REPORT_HEADING = '## Report';

/** Renders the whole section including the heading; ends with one `\n`. */
export function renderScoutReportSection(report: ScoutReport): string {
  const lines: string[] = [SCOUT_REPORT_HEADING, ''];
  const who = report.by.trim() === '' ? 'scout' : report.by.trim();
  lines.push(`Written on ${report.writtenAt} by ${who}.`, '', '### Summary', '');
  const summary = report.summary.trim();
  if (summary !== '') {
    lines.push(...summary.split('\n'));
  }
  if (report.decisions.length > 0) {
    if (summary !== '') {
      lines.push('');
    }
    lines.push('### Decisions', '');
    for (const decision of report.decisions) {
      let line = `- [${decision.resolved ? 'x' : ' '}] ${decision.key}: ${decision.question}`;
      if (decision.recommendation !== null && decision.recommendation.trim() !== '') {
        line += ` — Recommendation: ${decision.recommendation}`;
      }
      lines.push(line);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reads the section back; null when the heading is absent. Partially
 * unreadable parts degrade to defaults (an empty summary, a decision
 * line skipped) — the report card shows what the file actually says.
 */
export function parseScoutReportSection(text: string): ScoutReport | null {
  const section = sectionText(text);
  if (section === null) {
    return null;
  }
  const stamp = /^Written on (\S+) by (.+?)\.?$/m.exec(section);
  const summary = summaryOf(section);
  const decisions: ScoutDecision[] = [];
  const decisionsAt = section.indexOf('### Decisions');
  if (decisionsAt >= 0) {
    const tail = section.slice(decisionsAt);
    for (const raw of tail.split('\n')) {
      const line = raw.trim();
      const match = /^- \[([ xX])\] (\S+?): (.*?)(?: — Recommendation: (.*))?$/.exec(line);
      if (match === null) {
        continue;
      }
      decisions.push({
        key: match[2]!,
        question: match[3]!.trim(),
        recommendation: match[4] !== undefined && match[4].trim() !== '' ? match[4].trim() : null,
        resolved: match[1]!.toLowerCase() === 'x',
      });
    }
  }
  return {
    writtenAt: stamp?.[1] ?? '',
    by: stamp?.[2]?.trim() ?? '',
    summary,
    decisions,
  };
}

/**
 * Replaces the section, or inserts it before `## Log` (else appends at
 * the end). The replacement owns only its own block — everything before
 * and after survives byte-identical apart from the one blank line the
 * section keeps before a following heading.
 */
export function upsertScoutReportSection(fileText: string, section: string): string {
  const normalized = section.endsWith('\n') ? section : `${section}\n`;
  const current = boundsOf(fileText);
  if (current !== null) {
    const before = fileText.slice(0, current.start);
    const after = fileText.slice(current.end).replace(/^\n+/, '');
    return after === '' ? `${before}${normalized}` : `${before}${normalized}\n${after}`;
  }
  const logAt = /^## Log$/m.exec(fileText);
  if (logAt !== null) {
    return `${fileText.slice(0, logAt.index)}${normalized}\n${fileText.slice(logAt.index)}`;
  }
  return `${fileText.replace(/\n*$/, '')}\n\n${normalized}`;
}

/** True when the file carries a `## Report` section (any readability). */
export function hasScoutReport(text: string): boolean {
  return boundsOf(text) !== null;
}

/** The `### Summary` block's text without the heading; '' when absent. */
function summaryOf(section: string): string {
  const heading = /^### Summary[ \t]*\r?$/m.exec(section);
  if (heading === null) {
    return '';
  }
  const rest = section.slice(heading.index + heading[0].length);
  const next = /^### /m.exec(rest);
  const block = next === null ? rest : rest.slice(0, next.index);
  return block.trim();
}

/** The section's text without the heading's neighbours; null when absent. */
function sectionText(text: string): string | null {
  const bounds = boundsOf(text);
  return bounds === null ? null : text.slice(bounds.start, bounds.end);
}

/** [start, end) of the `## Report` block — end at the next H2 or EOF. */
function boundsOf(text: string): { start: number; end: number } | null {
  const heading = /^## Report$/m.exec(text);
  if (heading === null) {
    return null;
  }
  const rest = text.slice(heading.index);
  const next = /^## /gm.exec(rest.slice(SCOUT_REPORT_HEADING.length));
  const end = next === null ? text.length : heading.index + SCOUT_REPORT_HEADING.length + next.index;
  return { start: heading.index, end };
}
