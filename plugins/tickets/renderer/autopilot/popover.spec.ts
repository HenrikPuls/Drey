// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutopilotView } from '../../../../shared/autopilot';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the spec stands in for the host, which owns the catalog at runtime
import { i18n } from '../../../../shared/i18n';
import { stopAllNow, writeAutopilot, type AutopilotOutcome } from './controller';
import { openAutopilotPopover, type AutopilotPopover } from './popover';

const t = i18n.t.bind(i18n);
let open: AutopilotPopover | null = null;

afterEach(() => {
  open?.close();
  open = null;
});

function mount(initial: AutopilotView, reply: AutopilotOutcome = { ok: true, status: null }) {
  let view = initial;
  const set = vi.fn(async (record: AutopilotView) => {
    if (reply.ok) {
      view = record;
    }
    return reply;
  });
  const stopAll = vi.fn(async () => reply);
  open = openAutopilotPopover({ t, view: () => view, set, stopAll, formatTime: (d) => d.toISOString().slice(11, 16), now: () => new Date(2026, 10, 6, 10, 0) });
  return { set, stopAll, popover: open, setView: (next: AutopilotView) => (view = next) };
}

const row = (state: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-state=${state}]`)!;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the desktop popover', () => {
  it('lists On / Paused / Off and Stop-now, the current state checked', () => {
    mount({ state: 'on' });
    expect(Array.from(document.querySelectorAll('[role=radio]')).map((r) => r.textContent)).toEqual(['On', 'Paused', 'Off']);
    expect(row('on').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('.tickets-autopilot-stop')!.textContent).toBe('Stop all running steps now…');
  });

  it('switches the state and closes on Off', async () => {
    const { set } = mount({ state: 'on' });
    row('off').click();
    await flush();
    expect(set).toHaveBeenCalledWith({ state: 'off' });
    expect(document.querySelector('.tickets-autopilot-pop')).toBeNull();
  });

  it('stays open on Paused and takes the resume time: "Resume at {time}" shows once it is set', async () => {
    const { set, popover, setView } = mount({ state: 'on' });
    row('paused').click();
    await flush();
    expect(document.querySelector('.tickets-autopilot-pop')).not.toBeNull();
    const time = document.querySelector<HTMLInputElement>('input[type=time]')!;
    time.value = '18:30';
    time.dispatchEvent(new Event('change'));
    await flush();
    const last = set.mock.calls.at(-1)![0];
    expect(new Date(last.resumeAt!).getTime()).toBe(new Date(2026, 10, 6, 18, 30).getTime());
    setView(last);
    popover.refresh();
    expect(document.querySelector('.tickets-autopilot-resume-label')!.textContent).toMatch(/^Resume at \d\d:\d\d$/);
  });

  it('arms Stop-now first, then calls stop-all', async () => {
    const { stopAll } = mount({ state: 'on' });
    const stop = document.querySelector<HTMLButtonElement>('.tickets-autopilot-stop')!;
    stop.click();
    expect(stopAll).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('.tickets-autopilot-stop')!.click();
    await flush();
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it('shows the words of a refusal under the rows and stays open', async () => {
    mount({ state: 'on' }, { ok: false, words: t('autopilot.refused.bad_resume_at') });
    row('off').click();
    await flush();
    expect(document.querySelector('[role=alert]')!.textContent).toBe('That resume time is not in the future.');
  });

  it('closes on Escape', async () => {
    mount({ state: 'on' });
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.tickets-autopilot-pop')).toBeNull();
  });
});

describe('the Autopilot writes', () => {
  it('sends the record over chainAutopilot and the stop over chainAbort', async () => {
    const invoke = vi.fn(async () => ({ ok: true, status: { configured: true, master: 'run' } }));
    expect(await writeAutopilot({ invoke }, t, { state: 'on' })).toMatchObject({ ok: true });
    expect(invoke).toHaveBeenCalledWith('chainAutopilot', { state: 'on' });
    await stopAllNow({ invoke }, t);
    expect(invoke).toHaveBeenCalledWith('chainAbort', {});
  });

  it('maps each refusal code to its words', async () => {
    const words = async (code: string) =>
      (await writeAutopilot({ invoke: async () => ({ ok: false, error: code, code }) }, t, { state: 'on' })) as { words: string };
    expect((await words('read_only')).words).toBe('This device is paired read-only, so it cannot change the Autopilot.');
    expect((await words('bad_resume_at')).words).toBe('That resume time is not in the future.');
    expect((await words('bad_state')).words).toBe('The runner does not know that state.');
    expect((await words('runner_down')).words).toBe('The runner is not running.');
    expect((await words('zzz')).words).toBe('The change was refused.');
  });

  it('reads a thrown call or the chain\'s "not running" text as the runner being down', async () => {
    expect(await writeAutopilot({ invoke: async () => Promise.reject(new Error('x')) }, t, { state: 'on' })).toEqual({ ok: false, words: 'The runner is not running.' });
    expect(await stopAllNow({ invoke: async () => ({ ok: false, error: 'the fleet runner is not running' }) }, t)).toEqual({ ok: false, words: 'The runner is not running.' });
  });
});
