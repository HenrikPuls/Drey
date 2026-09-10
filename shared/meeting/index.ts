/**
 * `shared/meeting` — the pure, IPC-crossing meeting-invite logic: the
 * normalised `ParsedMeeting` shape, title slugification, date/time range
 * formatting, the mini template evaluator, and the meeting-section
 * renderer.
 *
 * The `.ics` / `.msg` *parsing* lives in `electron/meeting/` (it needs
 * Node libraries); everything here is browser-safe and testable on its
 * own.
 *
 * This barrel is the module's only public surface — import from
 * `shared/meeting`, never a file inside it (enforced by `eslint.config.mjs`).
 */

export type {
  MeetingAttachment,
  MeetingPerson,
  MeetingSource,
  ParsedMeeting,
} from './types';
export { slugifyMeetingTitle } from './slug';
export { meetingWhen, type MeetingWhen } from './when';
export {
  renderTemplate,
  STARTER_MEETING_TEMPLATE,
  type TemplateModel,
  type TemplateValue,
} from './template';
export { meetingModel, renderMeetingSection } from './render';
