// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { PipelinePhase } from '../shared/tickets';
import { createColumnsSection, type ColumnsState } from './settings-columns';

const phase = (id: string, title: string, handover = 'manual'): PipelinePhase =>
  ({
    id,
    title,
    handover,
    wip: null,
    claim: false,
    worker: null,
    model: null,
    prompt: null,
    maxRed: null,
    tokenBudget: null,
    maxTurns: null,
    maxWorkMin: null,
    ci: null,
    audit: null,
    semantic: false,
    color: null,
  }) as unknown as PipelinePhase;

const STATE: ColumnsState = {
  pipeline: [phase('inbox', 'Inbox'), phase('build', 'Build', 'agent build-default'), phase('qa', 'QA'), phase('done', 'Done')],
  folders: { root: '/t', moves: [] },
  promptRefs: ['build-default'],
  defaultWorker: 'opencode',
};

function setup(result: { ok: boolean; error?: string } = { ok: true }) {
  const invoke = vi.fn(async () => result);
  const api = {
    ui: { icon: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg') },
    backend: { invoke },
  } as unknown as DreyPluginApi;
  const reload = vi.fn(async () => undefined);
  const section = createColumnsSection(api, reload);
  document.body.append(section.root);
  section.update(STATE);
  return { section, invoke, reload };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the column editor', () => {
  it('builds one row per phase and an add form that offers every slot but after Done', () => {
    const { section } = setup();
    expect(section.root.querySelectorAll('.tset-row:not(.tset-row-head)')).toHaveLength(4);
    const options = [...section.root.querySelectorAll('.tset-add select option')].map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['inbox', 'build', 'qa']);
    // Default slot: just before Done.
    expect((section.root.querySelector('.tset-add select') as HTMLSelectElement).value).toBe('qa');
  });

  it('adds a column through editPhase and reloads', async () => {
    const { section, invoke, reload } = setup();
    (section.root.querySelector('.tset-add input') as HTMLInputElement).value = 'Security review';
    section.root.querySelector('.tset-add')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(invoke).toHaveBeenCalledWith('editPhase', { op: 'add', title: 'Security review', afterId: 'qa' });
    expect(reload).toHaveBeenCalled();
  });

  it('renames a title in place on Enter', async () => {
    const { section, invoke } = setup();
    const rename = section.root.querySelector('button[aria-label="Rename QA"]') as HTMLButtonElement;
    rename.click();
    const input = section.root.querySelector('.tset-name-input[aria-label="New name for QA"]') as HTMLInputElement;
    input.value = 'Quality';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(invoke).toHaveBeenCalledWith('editPhase', { op: 'rename', phase: 'qa', title: 'Quality' });
  });

  it('removal needs a second click, and the pinned ends have no bin', async () => {
    const { section, invoke } = setup();
    expect(section.root.querySelector('button[aria-label="Remove Inbox"]')).toBeNull();
    expect(section.root.querySelector('button[aria-label="Remove Done"]')).toBeNull();
    const bin = section.root.querySelector('button[aria-label="Remove QA"]') as HTMLButtonElement;
    bin.click();
    expect(invoke).not.toHaveBeenCalledWith('editPhase', expect.anything());
    bin.click();
    await flush();
    expect(invoke).toHaveBeenCalledWith('editPhase', { op: 'remove', phase: 'qa' });
  });

  it('says why a removal was refused and keeps the column', async () => {
    const { section } = setup({ ok: false, error: '2 tickets still in "QA" — move them to another column first' });
    const bin = section.root.querySelector('button[aria-label="Remove QA"]') as HTMLButtonElement;
    bin.click();
    bin.click();
    await flush();
    expect(section.root.querySelector('.tset-status')!.textContent).toContain('2 tickets still in "QA"');
    expect(section.root.querySelector('button[aria-label="Remove QA"]')).not.toBeNull();
  });
});
