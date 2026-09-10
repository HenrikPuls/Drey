/**
 * Turns a decoded `ParsedMeeting` into the Markdown block that gets
 * inserted into the open note, by filling the user's `templates/meeting.md`
 * (or the shipped `STARTER_MEETING_TEMPLATE`). Pure and shared so the
 * main-process importer and the unit tests render through exactly the same
 * path.
 */

import { slugifyMeetingTitle } from './slug';
import { renderTemplate, type TemplateModel } from './template';
import type { MeetingPerson, ParsedMeeting } from './types';
import { meetingWhen } from './when';

const FALLBACK_TITLE = 'Untitled meeting';

function personLabel(person: MeetingPerson | null): string {
  if (!person) {
    return '';
  }
  return person.name ?? person.email ?? '';
}

/** The placeholder model the meeting template is rendered against. */
export function meetingModel(meeting: ParsedMeeting): TemplateModel {
  const title = meeting.title.trim() === '' ? FALLBACK_TITLE : meeting.title.trim();
  const slug = slugifyMeetingTitle(meeting.title);
  const when = meetingWhen(meeting);

  return {
    title,
    slug,
    kebab_case_title: slug,
    date: when.date,
    end_date: when.end_date,
    start_time: when.start_time,
    end_time: when.end_time,
    when: when.when,
    location: meeting.location ?? '',
    organizer: personLabel(meeting.organizer),
    attendees: meeting.attendees.map((person) => ({
      name: personLabel(person),
      email: person.email ?? '',
    })),
    join_url: meeting.joinUrl ?? '',
    description: meeting.description ?? '',
    attachments: meeting.attachments.map((attachment) => ({ filename: attachment.filename })),
    source: meeting.source,
  };
}

/** The ready-to-insert meeting section — no surrounding blank lines. */
export function renderMeetingSection(meeting: ParsedMeeting, template: string): string {
  return renderTemplate(template, meetingModel(meeting));
}
