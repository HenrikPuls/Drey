import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect, type Page } from './fixtures/drey';

/** A minimal but real Outlook-style invite: embedded VTIMEZONE, TZID start/end, Teams URL. */
const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Microsoft//Outlook//EN',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010325T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'DTSTART:16011028T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'SUMMARY:Q3 Roadmap Review',
  'DTSTART;TZID=W. Europe Standard Time:20260915T140000',
  'DTEND;TZID=W. Europe Standard Time:20260915T150000',
  'LOCATION:Microsoft Teams Meeting',
  'ORGANIZER;CN=Jane Doe:mailto:jane@example.com',
  'ATTENDEE;CN=John Smith:mailto:john@example.com',
  'DESCRIPTION:Agenda then https://teams.microsoft.com/l/meetup-join/19%3axyz',
  'UID:evt-1',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

async function openNote(page: Page, vaultDir: string, name: string, body: string): Promise<void> {
  fs.writeFileSync(path.join(vaultDir, name), body);
  await page.locator('app-dock[side="left"] .icon-btn.refresh').click();
  await page.locator('app-dock[side="left"] .node.file', { hasText: name }).click();
  await expect(page.locator('app-editor .cm-content')).toBeVisible();
}

/** Drop a `File` with the given name/contents onto `.cm-content`. */
async function dropFile(page: Page, name: string, contents: string): Promise<void> {
  await page.evaluate(
    ({ name, contents }) => {
      const el = document.querySelector('app-editor .cm-content')!;
      const dt = new DataTransfer();
      dt.items.add(new File([contents], name, { type: 'text/calendar' }));
      for (const type of ['dragover', 'drop'] as const) {
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: 60,
          clientY: 60,
        });
        Object.defineProperty(event, 'dataTransfer', { value: dt });
        el.dispatchEvent(event);
      }
    },
    { name, contents },
  );
}

test.describe('drag a calendar invite into the editor', () => {
  test('an .ics dropped on the editor inserts a tagged meeting section', async ({
    page,
    vaultDir,
  }) => {
    await openNote(page, vaultDir, 'target.md', '# target\n\n');
    await page.locator('app-editor .cm-content').click();

    await dropFile(page, 'invite.ics', ICS);

    const editor = page.locator('app-editor .cm-content');
    await expect(editor).toContainText('Q3 Roadmap Review');
    await expect(editor).toContainText('#mtg/q3-roadmap-review');
    await expect(editor).toContainText('John Smith');

    await page.keyboard.press('ControlOrMeta+s');
    await expect
      .poll(() => fs.readFileSync(path.join(vaultDir, 'target.md'), 'utf-8'))
      .toMatch(/## 📅 Q3 Roadmap Review[\s\S]*#mtg\/q3-roadmap-review/);
    const saved = fs.readFileSync(path.join(vaultDir, 'target.md'), 'utf-8');
    expect(saved).toContain('[Join meeting](<https://teams.microsoft.com/l/meetup-join/19%3axyz>)');
    // The invite file itself is not copied into the vault.
    expect(fs.existsSync(path.join(vaultDir, 'attachments'))).toBe(false);
    // A `templates/meeting.md` was scaffolded so the user can customise it.
    expect(fs.existsSync(path.join(vaultDir, 'templates', 'meeting.md'))).toBe(true);
  });

  test('a malformed .ics shows a notice and writes nothing', async ({ page, vaultDir }) => {
    await openNote(page, vaultDir, 'note.md', '# note\n\n');
    await page.locator('app-editor .cm-content').click();

    await dropFile(page, 'broken.ics', 'this is not a calendar');

    await expect(page.locator('app-editor .err')).toContainText(/calendar invite/i);
    await expect(page.locator('app-editor .cm-content')).not.toContainText('#mtg/');
  });
});
