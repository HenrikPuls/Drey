// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../../shared/plugin-api/renderer';
import type { BoardSnapshot } from '../../shared/tickets';
import { createDeskSettings } from './desk-settings';

const videos = (inGit: boolean, maxMb = 25, existing = 0) => ({ ok: true, devices: [], engine: { videos: { inGit, maxMb, existing, notice: null } } });

function setup(settingsReply: unknown = videos(false)) {
  const invoke = vi.fn((method: string) => {
    if (method === 'personas') {
      return Promise.resolve([
        { id: 'paul', title: 'Paul', color: '#a', budget: 10, dailyCost: 1 },
        { id: 'you', kind: 'human', title: 'You', color: '#b', budget: null },
      ]);
    }
    if (method === 'settingsRead') {
      return Promise.resolve(settingsReply);
    }
    return Promise.resolve(videos(true, 40));
  });
  const api = { backend: { invoke }, settings: { get: () => Promise.resolve(undefined) } } as unknown as DreyPluginApi;
  const hooks = { openTeam: vi.fn(), openFlow: vi.fn(), manageRunners: vi.fn() };
  const desk = createDeskSettings(api, hooks);
  document.body.append(desk.root);
  const snapshot = {
    pipeline: [
      { id: 'inbox', title: 'Inbox', handover: 'manual', persona: null },
      { id: 'build', title: 'Build', handover: 'agent build', persona: 'paul' },
    ],
    columns: [
      { phase: { id: 'inbox' }, tickets: [{ id: 'T-0001', meta: { title: 'Idea' } }] },
      { phase: { id: 'build' }, tickets: [{ id: 'T-0002', meta: { title: 'Voice capture' } }] },
    ],
  } as unknown as BoardSnapshot;
  desk.update(snapshot);
  return { desk, invoke, hooks };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
};
const button = (root: HTMLElement, name: string): HTMLButtonElement => [...root.querySelectorAll('button')].find((b) => b.textContent === name)!;

describe('Settings → Tickets desk rows', () => {
  it('shows the team, the standard flow and the budget, and opens the Team tab', async () => {
    const { desk, hooks } = setup();
    await settle();
    expect([...desk.root.querySelectorAll('.tset-desk-chip')].map((n) => n.textContent)).toEqual(['Paul', 'You']);
    expect(desk.root.querySelector('.tset-desk-step')?.textContent).toBe('Build · Paul');
    expect(desk.root.textContent).toContain('$10 across 1 persona · $1 spent today');
    button(desk.root, 'Edit crew').click();
    expect(hooks.openTeam).toHaveBeenCalled();
  });

  it('opens the flow editor on the picked ticket, not an inbox idea', async () => {
    const { desk, hooks } = setup();
    await settle();
    const options = [...desk.root.querySelectorAll('select option')].map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['T-0002']);
    button(desk.root, 'Open flow editor').click();
    expect(hooks.openFlow).toHaveBeenCalledWith('T-0002');
  });

  it('turning videos in Git on asks first, then patches with the confirmation', async () => {
    const { desk, invoke } = setup(videos(false, 25, 2));
    await settle();
    const keep = desk.root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    keep.checked = true;
    keep.dispatchEvent(new Event('change'));
    expect(invoke).not.toHaveBeenCalledWith('settingsPatch', expect.anything());
    expect(desk.root.textContent).toContain('stay in the history once committed');
    button(desk.root, 'Keep in Git and include the 2 existing videos').click();
    await settle();
    expect(invoke).toHaveBeenCalledWith('settingsPatch', { inGit: true, confirm: true, includeExisting: true });
  });

  it('writes the largest video and refuses a non-number before asking the engine', async () => {
    const { desk, invoke } = setup();
    await settle();
    const limit = desk.root.querySelector<HTMLInputElement>('input[type=number]')!;
    expect(limit.value).toBe('25');
    limit.value = '60';
    limit.dispatchEvent(new Event('change'));
    await settle();
    expect(invoke).toHaveBeenCalledWith('settingsPatch', { maxMb: 60 });
    limit.value = 'many';
    limit.dispatchEvent(new Event('change'));
    expect(desk.root.textContent).toContain('whole number of megabytes');
  });
});
