import { signal, type Signal } from '@angular/core';

/** The width below which Mission Control is the phone (the shell's own breakpoint, req-96). */
export const PHONE_QUERY = '(max-width: 767.98px)';

/**
 * Whether the screen is the phone, live over a rotation or a resize. Without
 * `matchMedia` (a plain unit-test DOM) it reads false: the shared templates
 * keep their wide face there.
 */
export function phoneSignal(): Signal<boolean> {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return signal(false);
  }
  const query = window.matchMedia(PHONE_QUERY);
  const phone = signal(query.matches);
  query.addEventListener('change', (event) => phone.set(event.matches));
  return phone.asReadonly();
}

/**
 * The touch face (row 10, "one mobile system"): the phone and the iPad draw the
 * boards' pieces, the desktop web (a mouse, decision 13) keeps its wide
 * templates. Same test as the shell's (width + coarse pointer without hover).
 */
export const TOUCH_FACE_QUERY = `${PHONE_QUERY}, (hover: none) and (pointer: coarse)`;
const WIDE_QUERY = '(min-width: 768px)';
const COARSE_QUERY = '(hover: none) and (pointer: coarse)';
export const PAD_QUERY = [WIDE_QUERY, COARSE_QUERY].join(' and ');

function mediaSignal(query: string): Signal<boolean> {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return signal(false);
  }
  const list = window.matchMedia(query);
  const value = signal(list.matches);
  list.addEventListener('change', (event) => value.set(event.matches));
  return value.asReadonly();
}

/** Phone or iPad: the templates the boards draw. False on the desktop web and in a plain unit-test DOM. */
export function touchFaceSignal(): Signal<boolean> {
  return mediaSignal(TOUCH_FACE_QUERY);
}

/** The iPad only: where the touch face differs by size (boards 5b–5i, 10e–10s). */
export function padSignal(): Signal<boolean> {
  return mediaSignal(PAD_QUERY);
}

/** A past day as the phone's rows write it (boards 10b, 10k): `Mon` within the week, else `28 Oct`. */
export function shortDayOf(
  date: Date,
  daysAgo: number,
  i18n: { readonly locale: string; t(key: 'phone.day_month', params: { readonly day: string; readonly month: string }): string },
): string {
  if (daysAgo < 7) {
    return new Intl.DateTimeFormat(i18n.locale, { weekday: 'short' }).format(date);
  }
  const part = (type: 'day' | 'month'): string =>
    new Intl.DateTimeFormat(i18n.locale, { day: 'numeric', month: 'short' }).formatToParts(date).find((p) => p.type === type)?.value ?? '';
  return i18n.t('phone.day_month', { day: part('day'), month: part('month') });
}
