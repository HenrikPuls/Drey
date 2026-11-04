import type { ApplyResult } from './apply';
import type { ConversionPlan, TicketConversion } from './convert';
import type { ShadowDiff } from './shadow-diff';

/**
 * Text output of the migration: the dry run (stdout) and the report file
 * (Markdown). Both come from the same plan; the report adds the apply
 * outcome and the shadow diff when they exist.
 */

export interface ReportMeta {
  readonly legacyRoot: string;
  readonly storeDir: string | null;
  readonly generatedAt: string;
  readonly dkVersion: string | null;
}

export function renderDryRun(plan: ConversionPlan): string {
  const out: string[] = [];
  const migrating = plan.conversions.filter((c) => c.status === 'migrate');
  out.push(`DRY RUN: ${migrating.length} to migrate, ${plan.conversions.length - migrating.length} skipped, ${plan.placeholderNumbers.length} placeholder number(s) needed`);
  for (const c of plan.conversions) {
    out.push('', ...ticketLines(c));
  }
  out.push('', ...summaryLines(plan));
  return out.join('\n') + '\n';
}

function ticketLines(c: TicketConversion): string[] {
  if (c.target === null) {
    return [`${c.legacyId}  SKIP  (${c.phase})  ${c.skipReason}`];
  }
  const t = c.target;
  const lines = [`${c.legacyId} -> ${t.id}  [${c.phase} -> stage ${t.stage}]  ${t.title}`];
  lines.push(`    priority ${t.priority} | kind ${t.kind} | depends ${t.depends.join(', ') || '-'} | parent ${t.parent ?? '-'} | branch ${t.branch ?? '-'} | repos ${t.repos.join(', ') || '-'}`);
  lines.push(`    x-fields: ${Object.entries(t.extensions).map(([k, v]) => `${k}=${shorten(v)}`).join('; ')}`);
  lines.push(`    body: ${t.body.length} chars, ${(t.body.match(/^## .+$/gm) ?? []).map((h) => h.slice(3)).join(' / ') || 'no chapters'}`);
  for (const b of c.blocking) {
    lines.push(`    BLOCKS APPLY: ${b}`);
  }
  for (const w of c.warnings) {
    lines.push(`    warning: ${w}`);
  }
  for (const d of c.dropped) {
    lines.push(`    cannot carry: ${d.key} (${d.reason})`);
  }
  return lines;
}

function summaryLines(plan: ConversionPlan): string[] {
  const out: string[] = ['SUMMARY'];
  const byStage = new Map<string, number>();
  for (const c of plan.conversions) {
    if (c.target !== null) {
      byStage.set(c.target.stage, (byStage.get(c.target.stage) ?? 0) + 1);
    }
  }
  out.push(`  per stage: ${[...byStage].map(([s, n]) => `${s} ${n}`).join(', ') || '-'}`);
  if (plan.missingSelected.length > 0) {
    out.push(`  allow-list ids not found in the vault: ${plan.missingSelected.join(', ')}`);
  }
  if (plan.unreadable.length > 0) {
    out.push(`  unreadable files: ${plan.unreadable.map((u) => `${u.relPath} (${u.reason})`).join('; ')}`);
  }
  if (plan.placeholderNumbers.length > 0) {
    out.push(`  placeholders: ${plan.placeholderNumbers.length} cancelled tickets would fill the number gaps (dk v0.6.0 has no import with a fixed id, R-26)`);
  }
  const blocking = plan.conversions.filter((c) => c.blocking.length > 0).map((c) => c.legacyId);
  if (blocking.length > 0) {
    out.push(`  apply is blocked by: ${blocking.join(', ')}`);
  }
  return out;
}

export function renderReport(plan: ConversionPlan, meta: ReportMeta, apply: ApplyResult | null, shadow: ShadowDiff | null): string {
  const out: string[] = ['# Ticket migration report', ''];
  out.push(`- Generated: ${meta.generatedAt}`, `- Legacy vault (read only): \`${meta.legacyRoot}\``);
  out.push(`- Target store: ${meta.storeDir === null ? 'none (dry run)' : `\`${meta.storeDir}\``}`, `- dk: ${meta.dkVersion ?? 'not used'}`, '');
  const migrating = plan.conversions.filter((c) => c.status === 'migrate');
  out.push('## Counts', '', `- Selected: ${plan.conversions.length + plan.missingSelected.length}`, `- Migrated (planned): ${migrating.length}`, `- Skipped: ${plan.conversions.length - migrating.length}`, `- Not found: ${plan.missingSelected.length}`, `- Placeholders: ${plan.placeholderNumbers.length}`, '');
  out.push('## Tickets', '', '| Legacy | dricket | Stage | Title | Result |', '|---|---|---|---|---|');
  const outcome = new Map((apply?.outcomes ?? []).map((o) => [o.legacyId, o] as const));
  for (const c of plan.conversions) {
    const o = outcome.get(c.legacyId);
    const result = c.target === null ? `skipped: ${c.skipReason}` : o === undefined ? (apply === null ? 'planned' : 'not written') : o.status === 'failed' ? `FAILED: ${o.error}` : `created (rev ${o.rev ?? '?'})${o.error !== null ? `; ${o.error}` : ''}`;
    out.push(`| ${c.legacyId} | ${c.target?.id ?? '-'} | ${c.target?.stage ?? c.phase} | ${(c.target?.title ?? '').replace(/\|/g, '\\|')} | ${result} |`);
  }
  out.push('', '## Warnings and what could not be carried', '');
  let any = false;
  for (const c of plan.conversions) {
    for (const line of [...c.blocking.map((b) => `blocks apply: ${b}`), ...c.warnings, ...c.dropped.map((d) => `not carried: ${d.key} (${d.reason})`)]) {
      out.push(`- ${c.legacyId}: ${line}`);
      any = true;
    }
  }
  if (!any) {
    out.push('- none');
  }
  if (plan.placeholderNumbers.length > 0) {
    out.push('', '## Placeholders', '', `Numbers filled with cancelled placeholder tickets: ${plan.placeholderNumbers.map((n) => `t-${n}`).join(', ')}.`);
  }
  if (apply !== null) {
    out.push('', '## Apply', '', `- Complete: ${apply.complete ? 'yes' : 'NO'}`, `- Written: ${apply.outcomes.filter((o) => o.status !== 'failed').length}`, `- Failed: ${apply.outcomes.filter((o) => o.status === 'failed').length}`);
  }
  if (shadow !== null) {
    out.push('', '## Shadow diff', '', `- Compared: ${shadow.compared}`, `- Identical: ${shadow.identical ? 'yes' : 'NO'}`);
    for (const d of shadow.differences) {
      out.push(`- DIFF ${d.kind} ${d.id ?? ''}: legacy "${d.legacy}" vs store "${d.store}"`);
    }
    for (const d of shadow.declared) {
      out.push(`- declared ${d.id}: ${d.what}`);
    }
  }
  return out.join('\n') + '\n';
}

function shorten(value: string): string {
  return value.length > 40 ? `${value.slice(0, 37)}...` : value;
}
