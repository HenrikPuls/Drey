import { shell } from 'electron';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { externalDocumentExtension } from '../shared/external-document';

/**
 * Hands a document to the program the OS associates with it (ADR-0066).
 * Both entry points -- a vault file and a `file:` link in a note -- end
 * here, and both are checked against the document allowlist first: the
 * renderer's own check is a routing decision, this one is the guard.
 */
export async function openDocumentInDefaultProgram(absolutePath: string): Promise<void> {
  if (externalDocumentExtension(absolutePath) === null) {
    throw new Error('This file type is not opened in another program.');
  }
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }
  const failure = await shell.openPath(absolutePath);
  if (failure !== '') {
    throw new Error(`Could not open the file: ${failure}`);
  }
}

/**
 * The absolute path behind a `file:` link target, or a thrown user message.
 * Only a path on this machine: a link to a network share
 * (`file://server/share/...`) is refused, so a note cannot make the
 * machine contact a foreign host.
 */
export function localPathFromFileHref(href: string): string {
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    throw new Error('This link is not a valid file link.');
  }
  if (url.protocol !== 'file:') {
    throw new Error('This link is not a file link.');
  }
  if (url.hostname !== '' && url.hostname !== 'localhost') {
    throw new Error('Links to files on a network share are not opened.');
  }
  const absolutePath = fileURLToPath(url);
  if (absolutePath.startsWith('\\\\')) {
    throw new Error('Links to files on a network share are not opened.');
  }
  return absolutePath;
}
