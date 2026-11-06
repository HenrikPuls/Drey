import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { i18n } from '../../../../shared/i18n';
import type { McVerlaufEntry } from '../api/dto';
import { CostTable } from './cost-table';
import { costTableOf } from './cost-table.model';

const run = (patch: Partial<McVerlaufEntry> = {}): McVerlaufEntry => ({
  phase: 'build',
  persona: 'ben',
  model: 'sonnet',
  tokens: '48k',
  cost: 0.3,
  dauer: '9m',
  ausgang: 'handed-over',
  ...patch,
});
const title = (id: string): string => ({ plan: 'Plan', build: 'Build', review: 'Review' })[id] ?? id;

describe('costTableOf', () => {
  it('makes one row per settled run and totals tokens, time and cost', () => {
    const view = costTableOf(i18n, [run(), run({ phase: 'review', persona: 'ralf', model: 'haiku', cost: 0.04, dauer: '1m', tokens: '12k' })], title);
    expect(view.rows.map((r) => [r.phase, r.model, r.tokens, r.time, r.cost])).toEqual([
      ['Build', 'Ben · sonnet', '48k', '9 min', '$0.30'],
      ['Review', 'Ralf · haiku', '12k', '1 min', '$0.04'],
    ]);
    expect(view.rows[0]!.meta).toBe('Ben · sonnet · 48k · 9 min');
    expect(view.total).toEqual({ tokens: '60k', time: '10 min', cost: '$0.34' });
  });

  it('never counts an unknown figure as zero', () => {
    const view = costTableOf(i18n, [run({ cost: null, dauer: '', tokens: '', persona: null, model: null, ausgang: 'failed', phase: null })], title);
    expect(view.rows[0]).toMatchObject({ phase: '—', model: '', tokens: '', time: '', cost: '—', bad: true, meta: '' });
    expect(view.total).toEqual({ tokens: '', time: '', cost: '—' });
  });

  it('adds a quiet row for every phase of the chain that has not run — not for a checkpoint or a skipped step', () => {
    const view = costTableOf(i18n, [run({ phase: 'plan' })], title, [
      { id: 'plan', title: 'Plan' },
      { id: 'build', title: 'Build' },
      { id: 'review', title: 'Review', skipped: true },
      { id: 'accept', title: 'Accept', checkpoint: true },
    ]);
    expect(view.rows.map((r) => [r.phase, r.pending])).toEqual([
      ['Plan', false],
      ['Build', true],
    ]);
    expect(view.rows[1]!.cost).toBe('');
  });
});

describe('mc-cost-table', () => {
  const mount = (view: ReturnType<typeof costTableOf>): HTMLElement => {
    const fixture = TestBed.createComponent(CostTable);
    fixture.componentRef.setInput('view', view);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('draws Phase · Model · Tokens · Time · Cost, the rows and a total row', () => {
    const el = mount(costTableOf(i18n, [run()], title, [{ id: 'review', title: 'Review' }]));
    expect([...el.querySelectorAll('[role=columnheader]')].map((c) => c.textContent)).toEqual(['Phase', 'Model', 'Tokens', 'Time', 'Cost']);
    const rows = [...el.querySelectorAll('.ct-row:not(.ct-head)')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('Build');
    expect(rows[0]!.textContent).toContain('$0.30');
    expect(rows[1]!.textContent).toContain('no run yet');
    expect(rows[2]!.classList.contains('ct-total')).toBe(true);
    expect(rows[2]!.textContent).toContain('Total');
    expect(rows[2]!.textContent).toContain('$0.30');
  });

  it('carries the phone line: model, tokens and time as one meta line under the phase', () => {
    const el = mount(costTableOf(i18n, [run()], title));
    expect(el.querySelector('.ct-meta')?.textContent).toBe('Ben · sonnet · 48k · 9 min');
  });
});
