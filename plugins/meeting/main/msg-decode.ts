/**
 * `.msg` (Outlook OLE2 / CFBF) -> `ParsedMeeting`, via `@kenjiuno/msgreader`
 * (pure-JS, no native module). Appointment fields (`apptStartWhole` /
 * `apptEndWhole`) are UTC strings; `new Date()` parses them and the
 * formatter renders local, same as the `.ics` path.
 *
 * A `.msg` that is a plain e-mail rather than a meeting is rejected —
 * unless it carries an `.ics` attachment, in which case that is decoded
 * instead (Outlook forwards invites this way).
 */

import MsgReader from '@kenjiuno/msgreader';
import type { FieldsData } from '@kenjiuno/msgreader';
import type { MeetingPerson, ParsedMeeting } from './types';
import { formatDate, formatTimestamp } from '../../../shared/timestamp';
import { decodeIcs } from './ics-decode';
import { findJoinUrl } from './join-url';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function decodeMsg(bytes: Uint8Array): Promise<ParsedMeeting> {
  let reader: MsgReader;
  let root: FieldsData;
  try {
    reader = new MsgReader(toArrayBuffer(bytes));
    root = reader.getFileData();
  } catch {
    throw new Error('That file is not a recognised calendar invite.');
  }
  if (root.error) {
    throw new Error('That file is not a recognised calendar invite.');
  }

  const start = parseMsgDate(root.apptStartWhole);
  const end = parseMsgDate(root.apptEndWhole);

  if (!start && !end) {
    const embedded = await embeddedIcs(reader, root);
    if (embedded) {
      return embedded;
    }
    throw new Error('The invite has no event in it.');
  }

  const allDay = looksAllDay(start, end);
  const endForRange = allDay && end ? new Date(end.getTime() - DAY_MS) : end;

  const description = cleanText(root.body ?? null);
  const location = cleanText(root.location ?? null);

  return {
    title: (root.subject ?? '').trim(),
    start: start ? formatLocal(start, allDay) : null,
    end: endForRange ? formatLocal(endForRange, allDay) : null,
    allDay,
    location,
    organizer: organizerOf(root),
    attendees: attendeesOf(root),
    joinUrl: findJoinUrl([location, description]),
    description,
    attachments: attachmentsOf(root),
    source: 'msg',
  };
}

/** An `.ics` attachment inside a forwarded invite `.msg`. */
async function embeddedIcs(reader: MsgReader, root: FieldsData): Promise<ParsedMeeting | null> {
  const attachments = root.attachments ?? [];
  for (let index = 0; index < attachments.length; index += 1) {
    const name = attachments[index].fileName ?? attachments[index].fileNameShort ?? '';
    if (!/\.ics$/i.test(name)) {
      continue;
    }
    try {
      const file = reader.getAttachment(index);
      const text = new TextDecoder('utf-8').decode(file.content);
      return await decodeIcs(text);
    } catch {
      return null;
    }
  }
  return null;
}

/** A standalone `ArrayBuffer` view of `bytes` (it may sit at an offset in a pooled buffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function parseMsgDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** No dedicated flag is exposed — treat local-midnight-to-local-midnight as all-day. */
function looksAllDay(start: Date | null, end: Date | null): boolean {
  if (!start || !end) {
    return false;
  }
  const midnight = (date: Date): boolean =>
    date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  return midnight(start) && midnight(end) && end.getTime() - start.getTime() >= DAY_MS;
}

function formatLocal(date: Date, allDay: boolean): string {
  return allDay ? formatDate(date) : formatTimestamp(date);
}

function cleanText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const text = value.replace(/\r\n/g, '\n').replace(/\s+$/, '');
  return text === '' ? null : text;
}

function organizerOf(root: FieldsData): MeetingPerson | null {
  const name = (root.senderName ?? '').trim();
  const email = (root.senderEmail ?? root.senderSmtpAddress ?? '').trim();
  if (!name && !email) {
    return null;
  }
  return { name: name || null, email: email || null };
}

function attendeesOf(root: FieldsData): MeetingPerson[] {
  const out: MeetingPerson[] = [];
  const seen = new Set<string>();
  for (const recipient of root.recipients ?? []) {
    const name = (recipient.name ?? '').trim();
    const email = (recipient.email ?? recipient.smtpAddress ?? '').trim();
    if (!name && !email) {
      continue;
    }
    const key = (email || name).toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ name: name || null, email: email || null });
  }
  return out;
}

function attachmentsOf(root: FieldsData): { filename: string }[] {
  const out: { filename: string }[] = [];
  for (const attachment of root.attachments ?? []) {
    const filename = (attachment.fileName ?? attachment.fileNameShort ?? attachment.name ?? '').trim();
    if (filename && !/\.ics$/i.test(filename)) {
      out.push({ filename });
    }
  }
  return out;
}
