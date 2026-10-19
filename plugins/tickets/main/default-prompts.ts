/**
 * The prompts Drey ships for the tickets pipeline (req-50): real files,
 * `plugins/tickets/prompts/<ref>.md`, copied beside the built plugin by
 * `scripts/build-plugins.mjs`. "Initialize board" seeds them into
 * `tickets/_meta/prompts/`, and the settings page offers "Reset to the
 * shipped version" for a vault prompt of the same name. What the board
 * runs and the page shows is always the vault file; these are only the
 * seed, so nothing exists twice in code.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** `plugins/tickets/prompts/` from the source tree and from `dist-electron/plugins/tickets/`. */
export const SHIPPED_PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

const PROMPT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/;

/** Every shipped prompt, ref → text, in name order. A missing folder reads as none. */
export async function loadShippedPrompts(dir: string = SHIPPED_PROMPTS_DIR): Promise<Map<string, string>> {
  const names = (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => PROMPT_FILE.test(n)).sort();
  const prompts = new Map<string, string>();
  for (const name of names) {
    const text = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (text !== null) {
      prompts.set(name.slice(0, -3), text.replace(/\r\n/g, '\n'));
    }
  }
  return prompts;
}
