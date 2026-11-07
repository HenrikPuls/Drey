import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McI18nPipe } from './i18n.pipe';
import { McI18n } from './i18n.service';

/**
 * Mission Control's binding (ADR-0091): root-provided, answers from the
 * shipped English catalog, the `t` pipe reads the same instance, a missing
 * key shows as the key.
 */
@Component({
  selector: 'mc-i18n-host',
  imports: [McI18nPipe],
  template: `<span class="a">{{ 'state.ready_to_try' | t }}</span><span class="b">{{ 'cost.estimate.range' | t: params }}</span><span class="c">{{ 'no.such' | t }}</span>`,
})
class Host {
  readonly params = { low: '$3.00', high: '5.20', n: 1 };
}

describe('McI18n (Mission Control)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('is root-provided and answers from the English catalog', () => {
    const i18n = TestBed.inject(McI18n);
    expect(TestBed.inject(McI18n)).toBe(i18n);
    expect(i18n.locale).toBe('en');
    expect(i18n.t('autopilot.state.paused')).toBe('Paused');
    expect(i18n.t('autopilot.resume_at', { time: i18n.formatTime(new Date(2026, 10, 6, 15, 5)) })).toBe(
      'Resume at 15:05',
    );
    expect(i18n.t('cost.estimate.none')).toBe('no estimate yet (first run)');
    expect(i18n.currencyRange(3, 5.2).text).toBe('$3.00–5.20');
    expect(i18n.has('decision.accept')).toBe(true);
    expect(i18n.lookup('state.done')).toBe('Done');
  });

  it('renders through the t pipe and shows a missing key as the key', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.a')?.textContent).toBe('Ready to try');
    expect(el.querySelector('.b')?.textContent).toBe('$3.00–5.20 · from 1 run');
    expect(el.querySelector('.c')?.textContent).toBe('no.such');
  });
});
