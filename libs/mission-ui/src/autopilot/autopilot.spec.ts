/**
 * req-95b — the Autopilot clients: the iPad chip, the phone's app-bar button
 * with its sheet, the panel both open, the menu row, and the desk's folding
 * of the chain block. A read-only device sees the state and every control is
 * disabled; a refused write reads as words from the catalog.
 */
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import type { AutopilotView } from '../../../../shared/autopilot';
import { parseTeam } from '../api/dto';
import { Menu } from '../shell/menu';
import { MC_AUTOPILOT, autopilotRefusalOf, type McAutopilotReply, type McAutopilotState } from './autopilot-state';
import { AutopilotButton } from './button';
import { AutopilotChip } from './chip';
import { AutopilotPanel } from './panel';

function provide(initial: AutopilotView | null, opts: { readOnly?: boolean; reply?: McAutopilotReply } = {}) {
  const autopilot = signal<AutopilotView | null>(initial);
  const readOnly = signal(opts.readOnly === true);
  const set = vi.fn(async (record: AutopilotView): Promise<McAutopilotReply> => {
    const reply = opts.reply ?? { ok: true };
    if (reply.ok) {
      autopilot.set(record);
    }
    return reply;
  });
  const stopAll = vi.fn(async (): Promise<McAutopilotReply> => opts.reply ?? { ok: true });
  const state: McAutopilotState = { autopilot, readOnly, set, stopAll };
  TestBed.configureTestingModule({ providers: [{ provide: MC_AUTOPILOT, useValue: state }] });
  return { autopilot, readOnly, set, stopAll };
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  await fixture.whenStable();
  fixture.detectChanges();
}

const el = (fixture: ComponentFixture<unknown>): HTMLElement => fixture.nativeElement as HTMLElement;
const radios = (root: HTMLElement): HTMLButtonElement[] => Array.from(root.querySelectorAll<HTMLButtonElement>('[role=radio]'));

describe('the iPad chip', () => {
  it('reads "Autopilot · On" with a green dot and opens the popover with the three states', async () => {
    provide({ state: 'on' });
    const fixture = TestBed.createComponent(AutopilotChip);
    fixture.detectChanges();
    const chip = el(fixture).querySelector<HTMLButtonElement>('.chip')!;
    expect(chip.textContent).toContain('Autopilot · On');
    expect(chip.getAttribute('aria-label')).toBe('Autopilot, On');
    expect(el(fixture).querySelector('.dot')!.getAttribute('data-tone')).toBe('positive');
    expect(el(fixture).querySelector('.pop')).toBeNull();
    chip.click();
    fixture.detectChanges();
    expect(radios(el(fixture)).map((r) => r.textContent!.trim())).toEqual(['On', 'Paused', 'Off']);
    expect(radios(el(fixture)).map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('wears orange when Paused, grey when Off, and renders nothing without a chain', () => {
    const { autopilot } = provide({ state: 'paused' });
    const fixture = TestBed.createComponent(AutopilotChip);
    fixture.detectChanges();
    expect(el(fixture).querySelector('.dot')!.getAttribute('data-tone')).toBe('attention');
    autopilot.set({ state: 'off' });
    fixture.detectChanges();
    expect(el(fixture).querySelector('.dot')!.getAttribute('data-tone')).toBe('neutral');
    autopilot.set(null);
    fixture.detectChanges();
    expect(el(fixture).querySelector('.chip')).toBeNull();
  });

  it('follows the state it is given: nothing in it polls', async () => {
    const { autopilot } = provide({ state: 'on' });
    const fixture = TestBed.createComponent(AutopilotChip);
    fixture.detectChanges();
    autopilot.set({ state: 'off' });
    fixture.detectChanges();
    expect(el(fixture).querySelector('.chip')!.textContent).toContain('Autopilot · Off');
  });
});

describe('the panel', () => {
  it('switches the state and asks the host to close on On or Off', async () => {
    const { set } = provide({ state: 'on' });
    const fixture = TestBed.createComponent(AutopilotPanel);
    const done = vi.fn();
    fixture.componentInstance.done.subscribe(done);
    fixture.detectChanges();
    radios(el(fixture))[2]!.click();
    await settle(fixture);
    expect(set).toHaveBeenCalledWith({ state: 'off' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('keeps the panel open on Paused and offers the resume time under it', async () => {
    const { set } = provide({ state: 'on' });
    const fixture = TestBed.createComponent(AutopilotPanel);
    const done = vi.fn();
    fixture.componentInstance.done.subscribe(done);
    fixture.componentRef.setInput('now', () => new Date(2026, 10, 6, 10, 0));
    fixture.detectChanges();
    radios(el(fixture))[1]!.click();
    await settle(fixture);
    expect(set).toHaveBeenCalledWith({ state: 'paused' });
    expect(done).not.toHaveBeenCalled();
    const time = el(fixture).querySelector<HTMLInputElement>('input[type=time]')!;
    time.value = '18:30';
    time.dispatchEvent(new Event('change'));
    await settle(fixture);
    const last = set.mock.calls.at(-1)![0];
    expect(last.state).toBe('paused');
    expect(new Date(last.resumeAt!).getTime()).toBe(new Date(2026, 10, 6, 18, 30).getTime());
    expect(el(fixture).querySelector('.resume-label')!.textContent).toMatch(/^\s*Resume at /);
  });

  it('arms Stop-now on the first tap and calls the existing stop-all on the second', async () => {
    const { stopAll } = provide({ state: 'on' });
    const fixture = TestBed.createComponent(AutopilotPanel);
    fixture.detectChanges();
    const stop = el(fixture).querySelector<HTMLButtonElement>('.stop')!;
    expect(stop.textContent!.trim()).toBe('Stop all running steps now…');
    stop.click();
    fixture.detectChanges();
    expect(stopAll).not.toHaveBeenCalled();
    expect(stop.textContent!.trim()).toBe('Tap again to stop everything');
    stop.click();
    await settle(fixture);
    expect(stopAll).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal as words, never as its code', async () => {
    provide({ state: 'on' }, { reply: { ok: false, error: 'bad_resume_at', code: 'bad_resume_at' } });
    const fixture = TestBed.createComponent(AutopilotPanel);
    fixture.detectChanges();
    radios(el(fixture))[2]!.click();
    await settle(fixture);
    const alert = el(fixture).querySelector('[role=alert]')!;
    expect(alert.textContent).toBe('That resume time is not in the future.');
    expect(alert.textContent).not.toContain('bad_resume_at');
  });

  it('reads a 403 whose code a transport dropped as the read-only words', async () => {
    provide({ state: 'on' }, { reply: { ok: false, error: 'this device is paired read-only' } });
    const fixture = TestBed.createComponent(AutopilotPanel);
    fixture.detectChanges();
    radios(el(fixture))[2]!.click();
    await settle(fixture);
    expect(el(fixture).querySelector('[role=alert]')!.textContent).toContain('paired read-only');
  });

  it('on a read-only device shows the state and disables every control', async () => {
    const { set, stopAll } = provide({ state: 'paused' }, { readOnly: true });
    const fixture = TestBed.createComponent(AutopilotPanel);
    fixture.detectChanges();
    const root = el(fixture);
    expect(radios(root).every((r) => r.disabled)).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('.stop')!.disabled).toBe(true);
    expect(root.querySelector<HTMLInputElement>('input[type=time]')!.disabled).toBe(true);
    expect(radios(root)[1]!.getAttribute('aria-checked')).toBe('true');
    radios(root)[0]!.click();
    await settle(fixture);
    expect(set).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
  });
});

describe('the phone button and its sheet', () => {
  it('is a play icon with the state dot; a tap opens a sheet of three rows with Stop-now below', () => {
    provide({ state: 'paused' });
    const fixture = TestBed.createComponent(AutopilotButton);
    fixture.detectChanges();
    const root = el(fixture);
    const button = root.querySelector<HTMLButtonElement>('.btn')!;
    expect(button.getAttribute('aria-label')).toBe('Autopilot, Paused');
    expect(root.querySelector('.dot')!.getAttribute('data-tone')).toBe('attention');
    expect(root.querySelector('.sheet')).toBeNull();
    button.click();
    fixture.detectChanges();
    expect(root.querySelector('.sheet')!.getAttribute('role')).toBe('dialog');
    expect(radios(root)).toHaveLength(3);
    expect(root.querySelector('.stop')).not.toBeNull();
  });

  it('closes from the scrim and the close control, and renders nothing without a chain', () => {
    const { autopilot } = provide({ state: 'on' });
    const fixture = TestBed.createComponent(AutopilotButton);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLButtonElement>('.btn')!.click();
    fixture.detectChanges();
    el(fixture).querySelector<HTMLElement>('.scrim')!.click();
    fixture.detectChanges();
    expect(el(fixture).querySelector('.sheet')).toBeNull();
    autopilot.set(null);
    fixture.detectChanges();
    expect(el(fixture).querySelector('.btn')).toBeNull();
  });
});

describe('the menu row', () => {
  it('reads "Autopilot · On" with its dot and unfolds the panel', () => {
    provide({ state: 'on' });
    const fixture = TestBed.createComponent(Menu);
    fixture.detectChanges();
    const row = el(fixture).querySelector<HTMLButtonElement>('.row.autopilot')!;
    expect(row.textContent).toContain('Autopilot · On');
    expect(row.querySelector('.ap-dot')!.getAttribute('data-tone')).toBe('positive');
    row.click();
    fixture.detectChanges();
    expect(radios(el(fixture))).toHaveLength(3);
  });

  it('has no row without a chain', () => {
    provide(null);
    const fixture = TestBed.createComponent(Menu);
    fixture.detectChanges();
    expect(el(fixture).querySelector('.row.autopilot')).toBeNull();
  });
});

describe('the desk fold and the refusal mapping', () => {
  it('folds the chain block into the team: the record, or the master read through', () => {
    const timed = parseTeam([], { runs: [], chain: { master: 'halted', autopilot: { state: 'paused', resumeAt: '2026-11-06T18:00:00.000Z' } } });
    expect(timed.autopilot).toEqual({ state: 'paused', resumeAt: '2026-11-06T18:00:00.000Z' });
    expect(parseTeam([], { runs: [], chain: { master: 'run' } }).autopilot).toEqual({ state: 'on' });
    expect(parseTeam([], { runs: [] }).autopilot).toBeUndefined();
  });

  it('turns a refused body into a reply that carries the engine code', () => {
    expect(autopilotRefusalOf({ ok: false, error: 'bad_state', code: 'bad_state' }, 'x')).toEqual({ ok: false, error: 'bad_state', code: 'bad_state' });
    expect(autopilotRefusalOf({ ok: false, error: 'this device is paired read-only' }, 'x')).toMatchObject({ code: 'read_only' });
    expect(autopilotRefusalOf({}, 'The change was refused.')).toEqual({ ok: false, error: 'The change was refused.' });
  });
});
