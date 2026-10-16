/**
 * The text of a file as the user sees it right now (ADR-0071): the buffer
 * of its open tab when there is one — unsaved changes included — and the
 * file on disk otherwise.
 */
import { NO_VAULT, type VaultToolDeps } from './types';

export interface CurrentText {
  /** `\n` line ends. */
  text: string;
  /** Whether the file on disk uses `\r\n` (a tab's buffer keeps its own record of that). */
  crlf: boolean;
  /** Whether the text came from an open tab. */
  open: boolean;
}

/** `null` when the file neither is open nor exists. */
export async function currentText(
  deps: Pick<VaultToolDeps, 'vault' | 'openDocs'>,
  vaultId: string,
  path: string,
): Promise<CurrentText | null> {
  const open = (await deps.openDocs?.peek(vaultId, path)) ?? null;
  if (open !== null) {
    return { text: open.content.replace(/\r\n/g, '\n'), crlf: false, open: true };
  }
  if (vaultId === NO_VAULT) {
    // A tab that was never saved has no file behind it.
    return null;
  }
  try {
    const { content } = await deps.vault.readFile(path, vaultId);
    return { text: content.replace(/\r\n/g, '\n'), crlf: content.includes('\r\n'), open: false };
  } catch {
    return null;
  }
}

/** The unsaved buffers of open files, by `vaultId` + path — what a scan lays over the files it reads. */
export async function unsavedTexts(
  deps: Pick<VaultToolDeps, 'openDocs'>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const doc of (await deps.openDocs?.dirty()) ?? []) {
    out.set(unsavedKey(doc.vaultId, doc.path), doc.content.replace(/\r\n/g, '\n'));
  }
  return out;
}

export function unsavedKey(vaultId: string, path: string): string {
  return `${vaultId}\n${path}`;
}
