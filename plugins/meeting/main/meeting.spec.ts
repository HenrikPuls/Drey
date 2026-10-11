import { describe, expect, it } from 'vitest';
import { decodeIcs } from './ics-decode';
import { findJoinUrl } from './join-url';
import { slugifyMeetingTitle } from './slug';
import { meetingWhen } from './when';

/** A calendar file the way a mail client writes it: CRLF lines. */
function ics(...eventLines: string[]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Spec//EN',
    'BEGIN:VEVENT',
    'UID:spec-1',
    ...eventLines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

describe('slugifyMeetingTitle', () => {
  it('makes a tag-safe identifier out of a title', () => {
    expect(slugifyMeetingTitle('Weekly Sync: Team A/B')).toBe('weekly-sync-team-a-b');
    expect(slugifyMeetingTitle('Jahresübersicht & Größe (Café)')).toBe('jahresuebersicht-groesse-cafe');
  });

  it('drops the prefixes mail clients stack in front', () => {
    expect(slugifyMeetingTitle('RE: FW: AW: Weekly')).toBe('weekly');
    expect(slugifyMeetingTitle('Updated: Canceled: Planning')).toBe('planning');
    // Only as a prefix: a word that merely starts like one stays.
    expect(slugifyMeetingTitle('Review: budget')).toBe('review-budget');
  });

  it('falls back when nothing usable is left', () => {
    expect(slugifyMeetingTitle('')).toBe('meeting');
    expect(slugifyMeetingTitle('  ???  ')).toBe('meeting');
    expect(slugifyMeetingTitle('Re:')).toBe('meeting');
  });

  it('cuts a long title at a word boundary', () => {
    const slug = slugifyMeetingTitle('quarterly planning session for the whole engineering department and guests');
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe('quarterly-planning-session-for-the-whole-engineering');
    expect(slugifyMeetingTitle('x'.repeat(80))).toBe('x'.repeat(60));
  });
});

describe('findJoinUrl', () => {
  it('prefers a conferencing link over an earlier ordinary one', () => {
    expect(
      findJoinUrl([
        'Agenda: https://wiki.example.test/agenda',
        'Join: https://teams.microsoft.com/l/meetup-join/abc%40thread.v2/0?context=x.',
      ]),
    ).toBe('https://teams.microsoft.com/l/meetup-join/abc%40thread.v2/0?context=x');
  });

  it('takes the first link when none is a known conferencing host', () => {
    expect(findJoinUrl([null, '', 'Room 4, see <https://intranet.example.test/rooms/4>, then left'])).toBe(
      'https://intranet.example.test/rooms/4',
    );
    expect(findJoinUrl(['(https://example.test/a)'])).toBe('https://example.test/a');
  });

  it('finds nothing where there is no link', () => {
    expect(findJoinUrl([])).toBeNull();
    expect(findJoinUrl([null, undefined, '   ', 'Room 4', 'ftp://example.test/x'])).toBeNull();
  });
});

describe('meetingWhen', () => {
  it('describes a meeting within one day', () => {
    expect(meetingWhen({ start: '2026-09-15 14:00', end: '2026-09-15 15:00', allDay: false })).toEqual({
      date: '2026-09-15',
      end_date: '',
      start_time: '14:00',
      end_time: '15:00',
      when: '2026-09-15 · 14:00–15:00',
    });
    expect(meetingWhen({ start: '2026-09-15 14:00', end: null, allDay: false }).when).toBe('2026-09-15 · 14:00');
  });

  it('shows both ends when it runs past midnight', () => {
    expect(meetingWhen({ start: '2026-09-15 22:00', end: '2026-09-16 01:00', allDay: false }).when).toBe(
      '2026-09-15 22:00 – 2026-09-16 01:00',
    );
  });

  it('describes all-day meetings without times', () => {
    expect(meetingWhen({ start: '2026-09-15', end: '2026-09-15', allDay: true }).when).toBe('2026-09-15 (all day)');
    expect(meetingWhen({ start: '2026-09-15', end: '2026-09-17', allDay: true })).toEqual({
      date: '2026-09-15',
      end_date: '2026-09-17',
      start_time: '',
      end_time: '',
      when: '2026-09-15 – 2026-09-17 (all day)',
    });
  });

  it('is empty for an invite without a start', () => {
    expect(meetingWhen({ start: null, end: null, allDay: false }).when).toBe('');
  });
});

describe('decodeIcs', () => {
  it('reads title, time, place, people and the join link', async () => {
    const meeting = await decodeIcs(
      ics(
        'SUMMARY:Projekt Kickoff ',
        // Floating times: wall-clock on whatever machine runs the spec.
        'DTSTART:20260915T140000',
        'DTEND:20260915T153000',
        'LOCATION:Raum 4',
        'ORGANIZER;CN=Ada Lovelace:mailto:ada@example.test',
        'ATTENDEE;CN="Hopper, Grace":MAILTO:grace@example.test',
        'ATTENDEE:mailto:GRACE@example.test',
        'ATTENDEE:mailto:linus@example.test',
        'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/x',
        'DESCRIPTION:Agenda\\n1. Start\\n2. Ende\\n\\n',
        'ATTACH;FILENAME=plan.pdf:https://files.example.test/download?id=7',
        'ATTACH:https://files.example.test/docs/Budget%202026.xlsx?version=2',
        'ATTACH:https://files.example.test/no-extension',
      ),
    );

    expect(meeting).toEqual({
      title: 'Projekt Kickoff',
      start: '2026-09-15 14:00',
      end: '2026-09-15 15:30',
      allDay: false,
      location: 'Raum 4',
      organizer: { name: 'Ada Lovelace', email: 'ada@example.test' },
      attendees: [
        { name: 'Hopper, Grace', email: 'grace@example.test' },
        { name: null, email: 'linus@example.test' },
      ],
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/x',
      description: 'Agenda\n1. Start\n2. Ende',
      attachments: [{ filename: 'plan.pdf' }, { filename: 'Budget 2026.xlsx' }],
      source: 'ics',
    });
  });

  it('reports the last included day of an all-day range', async () => {
    const meeting = await decodeIcs(
      ics('SUMMARY:Offsite', 'DTSTART;VALUE=DATE:20260915', 'DTEND;VALUE=DATE:20260918'),
    );
    expect(meeting.allDay).toBe(true);
    expect(meeting.start).toBe('2026-09-15');
    expect(meeting.end).toBe('2026-09-17');
  });

  it('finds the join link in the description when no dedicated field has one', async () => {
    const meeting = await decodeIcs(
      ics(
        'SUMMARY:Call',
        'DTSTART:20260915T140000',
        'DESCRIPTION:Notes at https://wiki.example.test/x and join at https://zoom.us/j/123.',
      ),
    );
    expect(meeting.joinUrl).toBe('https://zoom.us/j/123');
    expect(meeting.organizer).toBeNull();
    expect(meeting.attendees).toEqual([]);
    expect(meeting.location).toBeNull();
  });

  it('survives an invite with next to nothing in it', async () => {
    const meeting = await decodeIcs(ics());
    expect(meeting.title).toBe('');
    expect(meeting.start).toBeNull();
    expect(meeting.end).toBeNull();
    expect(meeting.description).toBeNull();
  });

  it('prefers the single occurrence over the recurring series it belongs to', async () => {
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series',
      'SUMMARY:Series',
      'DTSTART:20260901T090000',
      'RRULE:FREQ=WEEKLY',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:series',
      'SUMMARY:This week only',
      'DTSTART:20260915T100000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    expect((await decodeIcs(text)).title).toBe('This week only');
  });

  it('refuses what is no calendar file, or has no event', async () => {
    await expect(decodeIcs('just some text')).rejects.toThrow('not a recognised calendar invite');
    await expect(decodeIcs('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n')).rejects.toThrow('no event');
  });
});
