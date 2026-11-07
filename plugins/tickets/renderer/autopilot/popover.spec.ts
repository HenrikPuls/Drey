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

interface MountOptions {
  readonly reply?: AutopilotOutcome;
  readonly cost?: string | null;
  readonly anchor?: HTMLElement;
}

function mount(initial: AutopilotView, options: MountOptions = {}) {
  const reply = options.reply ?? { ok: true, status: null };
  let view = initial;
  const set = vi.fn(async (record: AutopilotView) => {
    if (reply.ok) {
      view = record;
    }
    return reply;
  });
  const stopAll = vi.fn(async () => reply);
  const onClosed = vi.fn();
  open = openAutopilotPopover(
    {
      t,
      view: () => view,
      set,
      stopAll,
      formatTime: (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      chord: 'Mod+Alt+P',
      costText: () => (options.cost === undefined ? '$4.10 of $15 today' : options.cost),
      ...(options.anchor === undefined ? {} : { anchor: () => options.anchor! }),
      now: () => new Date(2026, 10, 6, 10, 0),
    },
    onClosed,
  );
  return { set, stopAll, onClosed, popover: open, setView: (next: AutopilotView) => (view = next) };
}

const pop = (): HTMLElement | null => document.querySelector<HTMLElement>('.tickets-autopilot-pop');
const row = (state: string): HTMLButtonElement => document.querySelector<HTMLButtonElement>(`[data-state=${state}]`)!;
const chips = (): (string | null)[] => Array.from(document.querySelectorAll('.tickets-autopilot-chip')).map((chip) => chip.textContent);
const timeField = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[type=time]')!;
const openTimeField = (): HTMLInputElement => {
  document.querySelector<HTMLButtonElement>('.tickets-autopilot-resume')!.click();
  return timeField();
};
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const AT_SIX = new Date(2026, 10, 6, 18, 0).toISOString();

describe('the desktop popover', () => {
  it('shows the board top to bottom: title and chord, the segments, the sentence, the chips, Stop-now', () => {
    mount({ state: 'on' });
    const parts = Array.from(pop()!.children).map((child) => child.className);
    expect(parts).toEqual([
      'tickets-autopilot-head',
      'tickets-autopilot-seg',
      'tickets-autopilot-sentence',
      'tickets-autopilot-chips',
      'tickets-autopilot-divider',
      'tickets-autopilot-stop',
      'tickets-autopilot-note',
    ]);
    expect(document.querySelector('.tickets-autopilot-title')!.textContent).toBe('Autopilot');
    expect(document.querySelector('.tickets-autopilot-chord')!.textContent).toBe('Mod+Alt+P');
    expect(Array.from(document.querySelectorAll('[role=radio]')).map((r) => r.textContent)).toEqual(['On', 'Paused', 'Off']);
    expect(row('on').getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('.tickets-autopilot-stop')!.textContent).toBe('Stop all running steps now…');
  });

  it('says the sentence of the state it is in', () => {
    const { popover, setView } = mount({ state: 'on' });
    const sentence = (): string | null => document.querySelector('.tickets-autopilot-sentence')!.textContent;
    expect(sentence()).toBe('Workers pick up and run tickets by themselves.');
    setView({ state: 'paused' });
    popover.refresh();
    expect(sentence()).toBe('Running steps finish, nothing new starts.');
    setView({ state: 'off' });
    popover.refresh();
    expect(sentence()).toBe('You start every step yourself.');
  });

  it('shows the resume chip on Paused only and the cost chip whenever a cost is known', () => {
    const { popover, setView } = mount({ state: 'on' });
    expect(chips()).toEqual(['$4.10 of $15 today']);
    setView({ state: 'paused', resumeAt: AT_SIX });
    popover.refresh();
    expect(chips()).toEqual(['Resume at 18:00', '$4.10 of $15 today']);
    setView({ state: 'paused' });
    popover.refresh();
    expect(chips()).toEqual(['Resume time', '$4.10 of $15 today']);
  });

  it('hides the chip row with nothing to show', () => {
    mount({ state: 'on' }, { cost: null });
    expect(document.querySelector<HTMLElement>('.tickets-autopilot-chips')!.hidden).toBe(true);
  });

  it('switches the state and stays open, so the sentence can be read', async () => {
    const { set } = mount({ state: 'on' });
    row('off').click();
    await flush();
    expect(set).toHaveBeenCalledWith({ state: 'off' });
    expect(pop()).not.toBeNull();
    expect(row('off').getAttribute('aria-checked')).toBe('true');
    expect(row('on').getAttribute('aria-checked')).toBe('false');
  });

  it('keeps the same buttons across a repaint, so a click in progress lands', () => {
    const { popover } = mount({ state: 'on' });
    const before = row('paused');
    popover.refresh();
    expect(row('paused')).toBe(before);
  });

  it('moves through the segments with the arrow keys, wrapping', async () => {
    const { set } = mount({ state: 'on' });
    expect(document.activeElement).toBe(row('on'));
    row('on').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await flush();
    expect(set).toHaveBeenCalledWith({ state: 'off' });
    expect(document.activeElement).toBe(row('off'));
    expect(row('off').tabIndex).toBe(0);
  });

  it('takes the resume time from the chip: the chip becomes a field, Enter writes it', async () => {
    const { set, popover, setView } = mount({ state: 'paused' });
    const field = openTimeField();
    expect(document.activeElement).toBe(field);
    field.value = '18:30';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    const last = set.mock.calls.at(-1)![0];
    expect(new Date(last.resumeAt!).getTime()).toBe(new Date(2026, 10, 6, 18, 30).getTime());
    setView(last);
    popover.refresh();
    expect(chips()[0]).toBe('Resume at 18:30');
  });

  it('writes the time when the field loses focus, and clears it when emptied', async () => {
    const { set } = mount({ state: 'paused', resumeAt: AT_SIX });
    const field = openTimeField();
    field.value = '';
    field.dispatchEvent(new Event('blur'));
    await flush();
    expect(set).toHaveBeenCalledWith({ state: 'paused' });
  });

  it('writes nothing for an unchanged time', async () => {
    const { set } = mount({ state: 'paused', resumeAt: AT_SIX });
    openTimeField().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(set).not.toHaveBeenCalled();
    expect(chips()[0]).toBe('Resume at 18:00');
  });

  it('Escape in the field drops the edit and leaves the popover open', async () => {
    const { set } = mount({ state: 'paused', resumeAt: AT_SIX });
    await flush();
    openTimeField().value = '20:00';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(pop()).not.toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(chips()[0]).toBe('Resume at 18:00');
  });

  it('a fleet event does not take the field away while it is being typed in', () => {
    const { popover } = mount({ state: 'paused' });
    const field = openTimeField();
    popover.refresh();
    expect(timeField()).toBe(field);
  });

  it('commits a typed time when the popover closes around it', async () => {
    const { set, popover } = mount({ state: 'paused' });
    openTimeField().value = '18:30';
    popover.close();
    await flush();
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('stands above its anchor: the right edge 51 px past the item, never off the window', () => {
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () => ({ right: window.innerWidth - 200 }) as DOMRect;
    mount({ state: 'on' }, { anchor });
    expect(pop()!.style.right).toBe('149px');
    open!.close();
    anchor.getBoundingClientRect = () => ({ right: window.innerWidth - 10 }) as DOMRect;
    mount({ state: 'on' }, { anchor });
    expect(pop()!.style.right).toBe('8px');
  });

  it('leaves the close to the anchor when the anchor is pressed, so its click can toggle', async () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const { onClosed } = mount({ state: 'on' }, { anchor });
    await flush();
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onClosed).not.toHaveBeenCalled();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onClosed).toHaveBeenCalledTimes(1);
    anchor.remove();
  });

  it('gives the focus back on close', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const { popover } = mount({ state: 'on' });
    expect(document.activeElement).not.toBe(before);
    popover.close();
    expect(document.activeElement).toBe(before);
    before.remove();
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

  it('shows the words of a refusal below Stop-now and stays open', async () => {
    mount({ state: 'on' }, { reply: { ok: false, words: t('autopilot.refused.bad_resume_at') } });
    row('off').click();
    await flush();
    expect(document.querySelector('[role=alert]')!.textContent).toBe('That resume time is not in the future.');
  });

  it('closes on Escape', async () => {
    mount({ state: 'on' });
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(pop()).toBeNull();
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
