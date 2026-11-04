/**
 * Writing the `## Plan` chapter (E10-3, concept v2 §5.8): the one place a
 * shape turn lets the model change a ticket. Everything outside the
 * chapter survives byte for byte; the chapter itself is replaced by the
 * model's text. A ticket without a `## Plan` gets one before its Log (or
 * at the end). Pure — the board service does the IO.
 */
import { fencedLineFlags, maskFences } from '../../../../shared/markdown/fences';

/** The text of the Plan chapter for a model's reply: trimmed, no stray `## Plan` heading of its own, `\n` newlines. */
export function normalizePlanBody(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/^\s*## Plan[ \t]*\n/, '')
    .trim();
}

/**
 * The ticket text with its Plan chapter set to `body`. A `## ` heading
 * inside the body would end the chapter early and swallow the next
 * section into the plan; those lines are demoted to `###` so the write
 * can never touch another chapter.
 */
export function withPlanSection(ticketText: string, rawBody: string): string {
  const bodyLines = normalizePlanBody(rawBody).split('\n');
  const fenced = fencedLineFlags(bodyLines);
  const body = bodyLines.map((line, i) => (!fenced[i] && /^## /.test(line) ? `#${line}` : line)).join('\n');
  const text = ticketText.replace(/\r\n/g, '\n');
  const scan = maskFences(text);
  const heading = /^## Plan[ \t]*$/m.exec(scan);
  if (heading !== null) {
    const start = heading.index + heading[0].length;
    const next = /^## /m.exec(scan.slice(start));
    const end = next === null ? text.length : start + next.index;
    const tail = text.slice(end);
    return `${text.slice(0, start)}\n\n${body}\n${tail === '' ? '' : `\n${tail}`}`;
  }
  const log = /^## Log[ \t]*$/m.exec(scan);
  const block = `## Plan\n\n${body}\n`;
  if (log !== null) {
    return `${text.slice(0, log.index)}${block}\n${text.slice(log.index)}`;
  }
  return `${text.replace(/\n*$/, '\n')}\n${block}`;
}
