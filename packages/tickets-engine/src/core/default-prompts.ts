/**
 * The prompts Drey ships for the tickets pipeline (req-50): real files,
 * `packages/tickets-engine/prompts/<ref>.md`, copied beside the compiled
 * engine by `scripts/build-plugins.mjs`. "Initialize board" seeds them into
 * `tickets/_meta/prompts/`, and the settings page offers "Reset to the
 * shipped version" for a vault prompt of the same name. What the board
 * runs and the page shows is always the vault file; these are only the
 * seed, so nothing exists twice in code.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

/** `packages/tickets-engine/prompts/` from the source tree and from `dist-electron/packages/tickets-engine/`. */
export const SHIPPED_PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');

/**
 * The version marker a shipped prompt opens with (`<!-- drey-prompt-version: N -->`).
 * Vault copies are snapshots seeded from the shipped file, so a copy
 * without the marker, or with a lower number, is older than what Drey ships —
 * the runner says so once and the settings page can reset it. The marker
 * line never reaches the model (`stripPromptVersion`).
 */
const PROMPT_VERSION_LINE = /^<!--\s*drey-prompt-version:\s*(\d+)\s*-->[ \t]*\r?\n/;

/** A prompt text's version; 0 when it carries no marker. */
export function promptVersion(text: string): number {
  const match = PROMPT_VERSION_LINE.exec(text);
  return match === null ? 0 : Number(match[1]);
}

/** The prompt text without its version marker line. */
export function stripPromptVersion(text: string): string {
  return text.replace(PROMPT_VERSION_LINE, '');
}

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
