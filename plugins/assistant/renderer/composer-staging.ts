import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import {
  extensionOf,
  externalFileKind,
  stagedAttachmentsDir,
  uniqueStagedName,
} from '../shared/stage.js';
import type { AssistantState } from './state.js';

/**
 * External-file paste/drop staging. Files dropped or pasted onto the
 * composer — vault files OR files from anywhere — are staged into the
 * vault (attachments/ beside the reference note, ADR-0024) and land as
 * chips: images hash-named via saveAsset, text files name-preserving and
 * uniqued, everything else skipped.
 *
 * The returned handler answers true when files ride on the event: it is
 * consumed so the editor doesn't also insert their content; routing
 * happens async per file.
 */
export function createStager(
  api: DreyPluginApi,
  state: AssistantState,
): (event: DragEvent | ClipboardEvent) => boolean {
  const stageExternalFile = async (file: File): Promise<boolean> => {
    const kind = externalFileKind(file.name);
    if (kind === null) {
      return false;
    }
    try {
      const reference = state.notePath() ?? state.activeChatPath() ?? 'chats/scratch.md';
      if (kind === 'image') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const assetPath = await api.vault.saveAsset(bytes, extensionOf(file.name), reference);
        state.addImage(assetPath);
        return true;
      }
      const dir = stagedAttachmentsDir(reference);
      const siblings = (await api.vault.listFiles())
        .filter((entry) => entry.type === 'file' && entry.relativePath.startsWith(`${dir}/`))
        .map((entry) => entry.relativePath.slice(dir.length + 1));
      const target = `${dir}/${uniqueStagedName(file.name, siblings)}`;
      await api.vault.writeFile(target, await file.text());
      state.addFile(target);
      return true;
    } catch {
      return false;
    }
  };

  return (event) => {
    const files =
      event instanceof DragEvent
        ? event.dataTransfer?.files
        : (event as ClipboardEvent).clipboardData?.files;
    if (files === undefined || files.length === 0) {
      return false;
    }
    for (const file of Array.from(files)) {
      void stageExternalFile(file);
    }
    return true;
  };
}
