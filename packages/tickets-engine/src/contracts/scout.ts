/**
 * The scout contract (E8, concept §5.6): the shapes the scout run, the
 * "Needs you" report card and the promotion command exchange. The
 * ticket-file format (`## Report`) is core/scout.ts; the full
 * specification is specs/ticket-schema.md.
 *
 * The flow: a scout ticket (`form: scout`) dispatches a scout run — no
 * worktree, no gate, no move. The worker reads repo/history/data and
 * writes the `## Report` section plus a decision list into its own
 * ticket file. The engine reads the section back and lays the report in
 * "Needs you"; the owner promotes the ticket to ship from there (a chat
 * command with confirmation), which is when plan, worktree and gate
 * enter the picture.
 */

/** One decision the owner must make, with the scout's recommendation. */
export interface ScoutDecision {
  /** The decision's short key as written (`D1`, `D2`, …). */
  readonly key: string;
  /** The question in the scout's words — what the owner decides. */
  readonly question: string;
  /** The scout's recommendation; null when the line carries none. */
  readonly recommendation: string | null;
  /** The owner's check mark (`- [x]`); open decisions stay `[ ]`. */
  readonly resolved: boolean;
}

/** The persisted scout report — `## Report`'s in-memory twin. */
export interface ScoutReport {
  /** When the report was written, ISO-8601. */
  readonly writtenAt: string;
  /** Who wrote it (the persona id, `pia`). */
  readonly by: string;
  /** The report's free-text body under `### Summary`. */
  readonly summary: string;
  readonly decisions: readonly ScoutDecision[];
}

/** The "Needs you" line's wording for one report. */
export function scoutNeedText(report: ScoutReport): string {
  const open = report.decisions.filter((d) => !d.resolved);
  if (open.length > 0) {
    return `${open.length} of ${report.decisions.length} decisions open — ${open[0]!.question}`;
  }
  if (report.decisions.length > 0) {
    return `all ${report.decisions.length} decisions resolved — ready to promote`;
  }
  return 'the scout report is ready';
}
