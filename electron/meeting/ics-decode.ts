/**
 * `.ics` (RFC 5545 / iCalendar) -> `ParsedMeeting`. Uses `ical.js` for the
 * line-unfolding, `KEY;PARAMS:VALUE` parsing and — the reason a
 * hand-rolled parser was rejected — resolving the `VTIMEZONE` blocks
 * Outlook embeds, so `DTSTART` / `DTEND` convert to the machine's local
 * wall time with no IANA timezone database shipped.
 *
 * `ical.js` 2.x is ESM-only with a namespace default export that Node16
 * CommonJS interop cannot surface cleanly, so it is pulled in with a
 * dynamic `import()` and typed against the small facade below (only the
 * handful of members this file touches).
 */

import type { MeetingPerson, ParsedMeeting } from '../../shared/meeting';
import { formatDate, formatTimestamp } from '../../shared/timestamp';
import { findJoinUrl } from './join-url';

interface IcalTime {
  isDate: boolean;
  toJSDate(): Date;
}

interface IcalProperty {
  getParameter(name: string): string | string[] | undefined;
  getFirstValue(): unknown;
}

interface IcalComponent {
  getAllSubcomponents(name: string): IcalComponent[];
  getFirstProperty(name: string): IcalProperty | null;
  getAllProperties(name: string): IcalProperty[];
  getFirstPropertyValue(name: string): unknown;
  hasProperty(name: string): boolean;
}

interface IcalEvent {
  summary: string | null;
  location: string | null;
  description: string | null;
  startDate: IcalTime | null;
  endDate: IcalTime | null;
}

interface IcalModule {
  parse(text: string): unknown;
  Component: new (jcal: unknown) => IcalComponent;
  Event: new (vevent: IcalComponent) => IcalEvent;
  Timezone: new (vtimezone: IcalComponent) => { tzid: string };
  TimezoneService: { has(tzid: string): boolean; register(zone: unknown): void };
}

let modulePromise: Promise<IcalModule> | undefined;

async function ical(): Promise<IcalModule> {
  modulePromise ??= import('ical.js').then(
    (mod) => (mod as { default: unknown }).default as IcalModule,
  );
  return modulePromise;
}

/** `X-` properties Outlook / Google use for the online-meeting link. */
const JOIN_URL_PROPS = [
  'x-microsoft-skypeteamsmeetingurl',
  'x-microsoft-onlinemeetingexternallink',
  'x-google-conference',
];

const DAY_MS = 24 * 60 * 60 * 1000;

export async function decodeIcs(text: string): Promise<ParsedMeeting> {
  const ICAL = await ical();

  let root: IcalComponent;
  try {
    root = new ICAL.Component(ICAL.parse(text));
  } catch {
    throw new Error('That file is not a recognised calendar invite.');
  }

  registerEmbeddedTimezones(ICAL, root);

  const vevents = root.getAllSubcomponents('vevent');
  const vevent = vevents.find((component) => !component.hasProperty('rrule')) ?? vevents[0];
  if (!vevent) {
    throw new Error('The invite has no event in it.');
  }

  const event = new ICAL.Event(vevent);
  const allDay = Boolean(event.startDate?.isDate);

  const startDate = event.startDate ? event.startDate.toJSDate() : null;
  let endDate = event.endDate ? event.endDate.toJSDate() : null;
  if (allDay && endDate) {
    // RFC 5545 all-day DTEND is exclusive — step back to the last included day.
    endDate = new Date(endDate.getTime() - DAY_MS);
  }

  const description = cleanText(event.description);
  const location = cleanText(event.location);

  const joinUrl = findJoinUrl([
    ...JOIN_URL_PROPS.map((name) => firstStringValue(vevent, name)),
    location,
    description,
  ]);

  return {
    title: (event.summary ?? '').trim(),
    start: startDate ? formatLocal(startDate, allDay) : null,
    end: endDate ? formatLocal(endDate, allDay) : null,
    allDay,
    location,
    organizer: personFrom(vevent.getFirstProperty('organizer')),
    attendees: attendeesOf(vevent),
    joinUrl,
    description,
    attachments: attachmentsOf(vevent),
    source: 'ics',
  };
}

function registerEmbeddedTimezones(ICAL: IcalModule, root: IcalComponent): void {
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    try {
      const timezone = new ICAL.Timezone(vtimezone);
      if (timezone.tzid && !ICAL.TimezoneService.has(timezone.tzid)) {
        ICAL.TimezoneService.register(timezone);
      }
    } catch {
      // A malformed VTIMEZONE just means toJSDate() falls back to UTC.
    }
  }
}

function formatLocal(date: Date, allDay: boolean): string {
  return allDay ? formatDate(date) : formatTimestamp(date);
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const text = value.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return text === '' ? null : text;
}

function firstStringValue(vevent: IcalComponent, name: string): string | null {
  const value = vevent.getFirstPropertyValue(name);
  return typeof value === 'string' ? value : null;
}

function personFrom(property: IcalProperty | null): MeetingPerson | null {
  if (!property) {
    return null;
  }
  const cn = property.getParameter('cn');
  const name = typeof cn === 'string' && cn.trim() !== '' ? cn.trim() : null;
  const raw = property.getFirstValue();
  const email = typeof raw === 'string' ? raw.replace(/^mailto:/i, '').trim() || null : null;
  if (!name && !email) {
    return null;
  }
  return { name, email };
}

function attendeesOf(vevent: IcalComponent): MeetingPerson[] {
  const out: MeetingPerson[] = [];
  const seen = new Set<string>();
  for (const property of vevent.getAllProperties('attendee')) {
    const person = personFrom(property);
    if (!person) {
      continue;
    }
    const key = (person.email ?? person.name ?? '').toLowerCase();
    if (key && seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(person);
  }
  return out;
}

function attachmentsOf(vevent: IcalComponent): { filename: string }[] {
  const out: { filename: string }[] = [];
  for (const property of vevent.getAllProperties('attach')) {
    const filename =
      paramString(property, 'filename') ??
      paramString(property, 'x-filename') ??
      lastPathSegment(property.getFirstValue());
    if (filename) {
      out.push({ filename });
    }
  }
  return out;
}

function paramString(property: IcalProperty, name: string): string | null {
  const value = property.getParameter(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function lastPathSegment(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.split(/[?#]/)[0].replace(/\/+$/, '');
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return segment && /\.[a-z0-9]{1,8}$/i.test(segment) ? decodeURIComponent(segment) : null;
}
