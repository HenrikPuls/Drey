import { extractInlineTags } from '../../../shared/tags';
import { renderMeetingSection } from '../../../plugins/meeting/main/render';
import { STARTER_MEETING_TEMPLATE } from '../../../plugins/meeting/main/template';
import type { ParsedMeeting } from '../../../plugins/meeting/main/types';

const BASE: ParsedMeeting = {
  title: 'Q3 Roadmap Review',
  start: '2026-09-15 14:00',
  end: '2026-09-15 15:00',
  allDay: false,
  location: 'Microsoft Teams Meeting',
  organizer: { name: 'Jane Doe', email: 'jane@example.com' },
  attendees: [
    { name: 'Jane Doe', email: 'jane@example.com' },
    { name: null, email: 'john@example.com' },
  ],
  joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ax%40thread.v2/0',
  description: 'Agenda\n- Review Q2\n- Confirm Q3',
  attachments: [{ filename: 'deck.pptx' }],
  source: 'ics',
};

function render(overrides: Partial<ParsedMeeting> = {}): string {
  return renderMeetingSection({ ...BASE, ...overrides }, STARTER_MEETING_TEMPLATE);
}

describe('renderMeetingSection', () => {
  it('renders a full invite with every section', () => {
    const out = render();
    expect(out).toContain('## 📅 Q3 Roadmap Review');
    expect(out).toContain('#mtg/q3-roadmap-review');
    expect(out).toContain('**📆 2026-09-15** · **🕒 14:00–15:00**');
    expect(out).toContain('Microsoft Teams Meeting');
    expect(out).toContain('### 👥 Participants');
    expect(out).toContain('- Jane Doe');
    expect(out).toContain('- john@example.com');
    expect(out).toContain('[Join meeting](<https://teams.microsoft.com/l/meetup-join/19%3ax%40thread.v2/0>)');
    expect(out).toContain('### 📝 Invitation');
    expect(out).toContain('- Confirm Q3');
    expect(out).toContain('### 📎 Attachments');
    expect(out).toContain('- deck.pptx');
    expect(out).toContain('### ✍️ Notes');
  });

  it('emits a #mtg/<slug> the real tag extractor recognises', () => {
    expect(extractInlineTags(render())).toContain('mtg/q3-roadmap-review');
  });

  it('keeps the human title (umlauts intact) in the heading but slugs the tag', () => {
    const out = render({ title: 'Über-Sync' });
    expect(out).toContain('## 📅 Über-Sync');
    expect(out).toContain('#mtg/ueber-sync');
  });

  it('omits sections whose data is missing, with no dangling blank lines', () => {
    const out = render({
      location: null,
      joinUrl: null,
      attendees: [],
      attachments: [],
      description: null,
    });
    expect(out).not.toContain('Participants');
    expect(out).not.toContain('Attachments');
    expect(out).not.toContain('Invitation');
    expect(out).not.toContain('[Join meeting]');
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('falls back to "Untitled meeting" / "meeting" for a blank subject', () => {
    const out = render({ title: '' });
    expect(out).toContain('## 📅 Untitled meeting');
    expect(out).toContain('#mtg/meeting');
  });

  it('renders an all-day range', () => {
    const out = render({ start: '2026-10-02', end: '2026-10-04', allDay: true });
    expect(out).toContain('**📆 2026-10-02**');
    expect(out).toContain('until 2026-10-04');
    expect(out).not.toContain('14:00');
  });
});
