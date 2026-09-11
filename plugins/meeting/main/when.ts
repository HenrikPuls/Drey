/**
 * Date / time fields for the meeting-section template, derived from a
 * `ParsedMeeting`. All inputs are already local wall-clock strings
 * (`YYYY-MM-DD` or `YYYY-MM-DD HH:mm`) produced by `electron/meeting/`, so
 * this module does no parsing beyond splitting on the space, and no
 * timezone maths at all.
 */

import type { ParsedMeeting } from './types';

export interface MeetingWhen {
  /** Start date, `YYYY-MM-DD`, or `''`. */
  date: string;
  /** End date when it differs from the start date, else `''`. */
  end_date: string;
  /** `HH:mm`, or `''` for an all-day / date-only meeting. */
  start_time: string;
  /** `HH:mm`, or `''`. */
  end_time: string;
  /** A single ready-made phrase: `2026-09-15 · 14:00–15:00`, `2026-09-15 – 2026-09-17 (all day)`, … */
  when: string;
}

interface Parts {
  date: string;
  time: string;
}

function split(value: string | null): Parts | null {
  if (!value) {
    return null;
  }
  const [date, time = ''] = value.split(' ');
  return { date, time };
}

export function meetingWhen(meeting: Pick<ParsedMeeting, 'start' | 'end' | 'allDay'>): MeetingWhen {
  const start = split(meeting.start);
  const end = split(meeting.end);

  const date = start?.date ?? '';
  const startTime = meeting.allDay ? '' : (start?.time ?? '');
  const endTime = meeting.allDay ? '' : (end?.time ?? '');
  const endDate = end && start && end.date !== start.date ? end.date : '';

  return {
    date,
    end_date: endDate,
    start_time: startTime,
    end_time: endTime,
    when: phrase(date, endDate, startTime, endTime, meeting.allDay),
  };
}

function phrase(
  date: string,
  endDate: string,
  startTime: string,
  endTime: string,
  allDay: boolean,
): string {
  if (!date) {
    return '';
  }
  if (allDay) {
    return endDate ? `${date} – ${endDate} (all day)` : `${date} (all day)`;
  }
  if (endDate) {
    // Spans midnight: show both ends fully.
    const left = startTime ? `${date} ${startTime}` : date;
    const right = endTime ? `${endDate} ${endTime}` : endDate;
    return `${left} – ${right}`;
  }
  if (startTime && endTime) {
    return `${date} · ${startTime}–${endTime}`;
  }
  if (startTime) {
    return `${date} · ${startTime}`;
  }
  return date;
}
