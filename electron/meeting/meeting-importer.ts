/**
 * Decodes a dropped / picked `.ics` or `.msg` invite into the Markdown
 * meeting section that gets inserted into the open note. Compute-only and
 * side-effect free apart from scaffolding `templates/meeting.md` on first
 * use — deliberately the same shape as `DailyNoteManager`, and kept out of
 * `VaultManager` for the same reason (template knowledge is not raw file
 * IO).
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { splitFrontmatter } from '../../shared/frontmatter';
import { renderMeetingSection, STARTER_MEETING_TEMPLATE } from '../../shared/meeting';
import type { ParsedMeeting } from '../../shared/meeting';
import { VaultManager } from '../vault-manager';
import { decodeIcs } from './ics-decode';
import { decodeMsg } from './msg-decode';

const TEMPLATE_DIR = 'templates';
const MEETING_TEMPLATE_FILE = 'meeting.md';

/** OLE2 / CFBF container magic — every `.msg` starts with it. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export class MeetingImporter {
  constructor(private readonly vaultManager: VaultManager) {}

  /**
   * `bytes` + `filename` -> the ready-to-insert meeting section (no
   * surrounding blank lines). Rejects with a user-facing message when the
   * file is not a calendar invite or carries no event.
   */
  async decode(bytes: Uint8Array, filename: string): Promise<string> {
    const meeting = await parse(bytes, filename);
    const template = await this.loadOrScaffoldTemplate();
    return renderMeetingSection(meeting, template);
  }

  /** Current `templates/meeting.md` (frontmatter stripped), scaffolding the starter on first use. */
  private async loadOrScaffoldTemplate(): Promise<string> {
    const vaultRoot = this.vaultManager.getActiveVaultPath();
    if (!vaultRoot) {
      // No vault to read from / write to — render from the built-in default.
      return stripFrontmatter(STARTER_MEETING_TEMPLATE);
    }
    const templatePath = path.join(vaultRoot, TEMPLATE_DIR, MEETING_TEMPLATE_FILE);
    try {
      return stripFrontmatter(await fsp.readFile(templatePath, 'utf-8'));
    } catch {
      try {
        await fsp.mkdir(path.dirname(templatePath), { recursive: true });
        await fsp.writeFile(templatePath, STARTER_MEETING_TEMPLATE, 'utf-8');
      } catch {
        // A read-only vault still gets a rendered section from the default.
      }
      return stripFrontmatter(STARTER_MEETING_TEMPLATE);
    }
  }
}

function stripFrontmatter(template: string): string {
  const { body, hadFence } = splitFrontmatter(template);
  return hadFence ? body.replace(/^\s+/, '') : template;
}

function parse(bytes: Uint8Array, filename: string): Promise<ParsedMeeting> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.msg' || (ext !== '.ics' && looksLikeOle2(bytes))) {
    return decodeMsg(bytes);
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  if (ext === '.ics' || /BEGIN:VCALENDAR/i.test(text.slice(0, 2048))) {
    return decodeIcs(text);
  }
  return Promise.reject(new Error('That file is not a recognised calendar invite.'));
}

function looksLikeOle2(bytes: Uint8Array): boolean {
  if (bytes.length < OLE2_MAGIC.length) {
    return false;
  }
  return OLE2_MAGIC.every((byte, index) => bytes[index] === byte);
}
