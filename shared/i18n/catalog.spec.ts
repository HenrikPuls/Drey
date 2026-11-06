import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import en from './catalog/en.json';
import {
  DEFAULT_LOCALE,
  MESSAGE_KEY_PATTERN,
  SUPPORTED_LOCALES,
  catalogKeys,
  isMessageKey,
  loadCatalog,
  resolveLocale,
} from './catalog';

/**
 * The catalog loader and the English file itself (ADR-0091): every key
 * follows the naming scheme, every message is valid ICU, and the first
 * entries the canvas decisions asked for are present.
 */
describe('the message catalog', () => {
  it('ships English as the first and only locale', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(loadCatalog('en')).toBe(en);
  });

  it('resolves any locale to a shipped catalog, English as the fallback', () => {
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale('en-GB')).toBe('en');
    expect(resolveLocale('EN_us')).toBe('en');
    expect(resolveLocale('de-DE')).toBe('en');
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale(null)).toBe('en');
    expect(resolveLocale('')).toBe('en');
    expect(loadCatalog('fr')).toBe(en);
    expect(loadCatalog()).toBe(en);
  });

  it('names every key <area>.<thing>[.<state>] in lower snake case', () => {
    const offenders = catalogKeys().filter((key) => !MESSAGE_KEY_PATTERN.test(key));
    expect(offenders).toEqual([]);
    expect(isMessageKey('autopilot.state.on')).toBe(true);
    expect(isMessageKey('cost.so_far')).toBe(true);
    expect(isMessageKey('Autopilot')).toBe(false);
    expect(isMessageKey('autopilot')).toBe(false);
    expect(isMessageKey('autopilot.State')).toBe(false);
    expect(isMessageKey('autopilot..on')).toBe(false);
    expect(isMessageKey('Ready to try')).toBe(false);
  });

  it('holds only messages the ICU runtime can compile', () => {
    const broken = catalogKeys().filter((key) => {
      try {
        new IntlMessageFormat(en[key], 'en');
        return false;
      } catch {
        return true;
      }
    });
    expect(broken).toEqual([]);
  });

  it('has no empty message and no message that is only its own key', () => {
    for (const key of catalogKeys()) {
      expect(en[key].trim(), key).not.toBe('');
      expect(en[key], key).not.toBe(key);
    }
  });

  it('carries the first entries of the canvas decisions', () => {
    // Autopilot (concept §6.1, roadmap req-95).
    expect(en['autopilot.title']).toBe('Autopilot');
    expect(en['autopilot.state.on']).toBe('On');
    expect(en['autopilot.state.paused']).toBe('Paused');
    expect(en['autopilot.state.off']).toBe('Off');
    expect(en['autopilot.stop_all']).toBe('Stop all running steps now…');
    expect(en['autopilot.resume_at']).toBe('Resume at {time}');
    // The one state list (decision 15) and the decision verb (decisions 10, 16).
    expect(
      (['inbox', 'shaping', 'prioritized', 'building', 'review', 'ready_to_try', 'done'] as const).map(
        (state) => en[`state.${state}`],
      ),
    ).toEqual(['Inbox', 'Shaping', 'Prioritized', 'Building', 'Review', 'Ready to try', 'Done']);
    expect(en['decision.accept']).toBe('Accept');
    expect(en['decision.send_back']).toBe('Send back');
    // The estimate format (decision 20, concept §5.4).
    expect(en['cost.estimate.none']).toBe('no estimate yet (first run)');
    expect(en['cost.estimate.range']).toContain('{n, plural,');
    expect(en['cost.so_far']).toBe('so far');
    expect(en['cost.in_total']).toBe('in total');
  });
});
