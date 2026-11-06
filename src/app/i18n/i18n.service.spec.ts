import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nPipe } from './i18n.pipe';
import { I18nService } from './i18n.service';

/**
 * The renderer binding (ADR-0091): the injectable answers from the shipped
 * English catalog, the pipe reads the same instance, and a missing key
 * comes back as the key (the dev warning is the facade's, checked there).
 */
@Component({
  selector: 'drey-i18n-host',
  imports: [I18nPipe],
  template: `<span class="a">{{ 'autopilot.title' | t }}</span><span class="b">{{ 'autopilot.resume_at' | t: { time: '9:30 AM' } }}</span><span class="c">{{ 'no.such' | t }}</span>`,
})
class Host {}

describe('I18nService (renderer)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('translates typed keys and formats with Intl in English', () => {
    const i18n = TestBed.inject(I18nService);
    expect(i18n.locale).toBe('en');
    expect(i18n.t('autopilot.state.on')).toBe('On');
    expect(i18n.t('cost.estimate.range', { ...rangeParams(i18n), n: 3 })).toBe('$3.00–5.20 · from 3 runs');
    expect(i18n.lookup('state.ready_to_try')).toBe('Ready to try');
    expect(i18n.has('decision.accept')).toBe(true);
    expect(i18n.formatDuration(125_000)).toBe('2 min 5 sec');
    expect(i18n.formatDate(new Date(2026, 10, 6))).toBe('Nov 6, 2026');
  });

  it('is one instance per injector and exposes the facade for the plugin host', () => {
    const i18n = TestBed.inject(I18nService);
    expect(TestBed.inject(I18nService)).toBe(i18n);
    expect(i18n.facade.t('autopilot.state.off')).toBe('Off');
    expect(i18n.facade).toBe(i18n.facade);
  });

  it('renders through the t pipe and shows a missing key as the key', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.a')?.textContent).toBe('Autopilot');
    expect(el.querySelector('.b')?.textContent).toBe('Resume at 9:30 AM');
    expect(el.querySelector('.c')?.textContent).toBe('no.such');
  });
});

function rangeParams(i18n: I18nService): { low: string; high: string } {
  const range = i18n.currencyRange(3, 5.2);
  return { low: range.low, high: range.high };
}
