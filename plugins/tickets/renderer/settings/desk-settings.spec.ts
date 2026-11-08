// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the spec stands in for the host, which owns the catalog at runtime
import { i18n } from '../../../../shared/i18n';
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
    if (method === 'chainStatus') {
      return Promise.resolve({ master: 'run' });
    }
    if (method === 'settingsRead') {
      return Promise.resolve(settingsReply);
    }
    if (method === 'serviceSettings') {
      return Promise.resolve({ enabled: false, autostart: false });
    }
    if (method === 'serviceSettingsSet') {
      return Promise.resolve({ enabled: true, autostart: false });
    }
    return Promise.resolve(videos(true, 40));
  });
  const api = { i18n, backend: { invoke }, settings: { get: () => Promise.resolve(undefined) } } as unknown as DreyPluginApi;
  const hooks = { openTeam: vi.fn(), openFlow: vi.fn(), manageRunners: vi.fn(), openAutopilot: vi.fn() };
  const desk = createDeskSettings(api, hooks);
  document.body.replaceChildren(desk.root, desk.videos);
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
  it('shows the crew, the flow as one line and the budget, and opens the Team tab', async () => {
    const { desk, hooks } = setup();
    await settle();
    expect(desk.root.querySelector('.tset-set-controls')?.textContent).toContain('Paul');
    expect(desk.root.textContent).not.toContain('Paul, You');
    expect(desk.root.querySelector('[aria-label="Standard flow"]')?.textContent).toBe('Build');
    expect(desk.root.textContent).toContain('$10 across 1 persona · $1 spent today');
    button(desk.root, 'Edit crew').click();
    expect(hooks.openTeam).toHaveBeenCalled();
  });

  it('draws every setting as the board does: bold name, description, then the control', async () => {
    const { desk } = setup();
    await settle();
    const names = [...desk.root.querySelectorAll('.tset-set-name')].map((n) => n.textContent);
    expect(names).toEqual(['Personas', 'Your name', 'Default flow', 'Autopilot', 'Resume paused autopilot at', 'Run in the background', 'Start with Windows', 'Daily budget', 'Runners']);
    expect([...desk.root.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Crew', 'Flow', 'Autopilot', 'Background service', 'Budget and runners']);
    expect([...document.querySelectorAll('section')].map((n) => (n as HTMLElement).dataset['settingsSection'])).toEqual(['crew', 'flow', 'autopilot', 'service', 'budget', 'videos']);
  });

  it('req-164: the background service is off by default; start with Windows waits for it', async () => {
    const { desk, invoke } = setup();
    await settle();
    const enabled = desk.root.querySelector<HTMLInputElement>('#tset-service-enabled')!;
    const autostart = desk.root.querySelector<HTMLInputElement>('#tset-service-autostart')!;
    expect(enabled.checked).toBe(false);
    expect(autostart.disabled).toBe(true);
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change'));
    expect(invoke).toHaveBeenCalledWith('serviceSettingsSet', { enabled: true });
    await settle();
    expect(autostart.disabled).toBe(false);
  });

  it('opens the flow editor on the picked ticket, not an inbox idea', async () => {
    const { desk, hooks } = setup();
    await settle();
    const options = [...desk.root.querySelectorAll('select[aria-label="Ticket to edit the flow of"] option')].map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['T-0002']);
    button(desk.root, 'Open flow editor').click();
    expect(hooks.openFlow).toHaveBeenCalledWith('T-0002');
  });

  it('turning videos in Git on asks first, then patches with the confirmation', async () => {
    const { desk, invoke } = setup(videos(false, 25, 2));
    await settle();
    const keep = desk.videos.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    keep.checked = true;
    keep.dispatchEvent(new Event('change'));
    expect(invoke).not.toHaveBeenCalledWith('settingsPatch', expect.anything());
    expect(desk.videos.textContent).toContain('stay in the history once committed');
    button(desk.videos, 'Keep in Git and include the 2 existing videos').click();
    await settle();
    expect(invoke).toHaveBeenCalledWith('settingsPatch', { inGit: true, confirm: true, includeExisting: true });
  });

  it('writes the largest video and refuses a non-number before asking the engine', async () => {
    const { desk, invoke } = setup();
    await settle();
    const limit = desk.videos.querySelector<HTMLInputElement>('input[type=number]')!;
    expect(limit.value).toBe('25');
    limit.value = '60';
    limit.dispatchEvent(new Event('change'));
    await settle();
    expect(invoke).toHaveBeenCalledWith('settingsPatch', { maxMb: 60 });
    limit.value = 'many';
    limit.dispatchEvent(new Event('change'));
    expect(desk.videos.textContent).toContain('whole number of megabytes');
  });

  it('shows the Autopilot state as words and opens the popover from "Change…" (board 7g)', async () => {
    const { desk, hooks } = setup();
    await settle();
    expect(desk.root.querySelector('#tset-autopilot')?.textContent).toBe('On');
    expect(desk.root.querySelector('select[aria-label="Autopilot"]')).toBeNull();
    const time = desk.root.querySelector<HTMLInputElement>('input[type="time"]')!;
    expect(time.disabled).toBe(true); // only a Paused state takes a resume time
    button(desk.root, 'Change…').click();
    expect(hooks.openAutopilot).toHaveBeenCalled();
  });

  it('writes a resume time as a paused autopilot and shows a refusal as words, not a code', async () => {
    const { desk, invoke } = setup();
    await settle();
    invoke.mockImplementation((method: string) =>
      Promise.resolve(
        method === 'chainAutopilot' ? { ok: false, error: 'this device is paired read-only', code: 'read_only' } : { master: 'run', autopilot: { state: 'paused' } },
      ),
    );
    const time = desk.root.querySelector<HTMLInputElement>('input[type="time"]')!;
    time.disabled = false;
    time.value = '18:00';
    time.dispatchEvent(new Event('change'));
    await settle();
    expect(invoke).toHaveBeenCalledWith('chainAutopilot', expect.objectContaining({ state: 'paused' }));
    expect(desk.root.querySelector('[role="alert"]')!.textContent).toContain('paired read-only');
  });
});
