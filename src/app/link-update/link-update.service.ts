import { Injectable, inject, signal } from '@angular/core';
import { RenameLinksPreview, RenameLinksRequest } from '../../../shared/ipc-api';
import { NOTE_FILE } from '../../../shared/wikilinks';
import { ConfirmDialogService } from '../services/confirm-dialog.service';
import { EditorService, docKey } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../vault';

/** How the rename dialog was answered. */
export type LinkUpdateChoice = 'update' | 'rename' | 'cancel';

/** The dialog's state: what is being renamed and what it would change. */
export interface PendingLinkUpdate {
  readonly fromRel: string;
  readonly toRel: string;
  readonly preview: RenameLinksPreview;
  resolve: (answer: { choice: LinkUpdateChoice; dontAskAgain: boolean }) => void;
}

/**
 * Renames / moves a vault entry and keeps what points at it intact
 * (milestone 59, ADR-0059): the links other notes hold to a renamed note,
 * and the attachments a moved note embeds. The Files panel routes every
 * rename and move through {@link rename}.
 *
 * Main plans and writes (`electron/link-rewriter.ts`); this side decides
 * WHETHER -- Settings -> Vault's `updateLinksOnRename` (`ask` shows the
 * affected notes in `LinkUpdateDialog` first) -- and looks after the open
 * tabs: dirty notes are handed over as buffers and patched in place rather
 * than on disk, clean ones re-read, and every tab under the renamed path
 * is re-keyed.
 */
@Injectable({ providedIn: 'root' })
export class LinkUpdateService {
  private readonly vault = inject(VaultService);
  private readonly editor = inject(EditorService);
  private readonly settings = inject(SettingsService);
  private readonly dialogs = inject(ConfirmDialogService);

  /** The rename awaiting an answer, if any (the dialog's `@if` gate). */
  readonly pending = signal<PendingLinkUpdate | null>(null);

  /**
   * Renames `fromRel` to `toRel` (possibly into another vault). Resolves to
   * the new vault-relative path, or `null` when the user cancelled. Errors
   * of the rename itself propagate.
   */
  async rename(
    fromVaultId: string,
    fromRel: string,
    toVaultId: string,
    toRel: string,
  ): Promise<string | null> {
    const mode = this.settings.config()?.vault.updateLinksOnRename ?? 'ask';
    if (mode === 'never') {
      return this.plainRename(fromVaultId, fromRel, toVaultId, toRel);
    }

    const request: RenameLinksRequest = {
      fromRel,
      toRel,
      fromVaultId,
      toVaultId,
      buffers: this.editor
        .openDocs()
        .filter(
          (d) =>
            d.kind === 'text' &&
            d.vaultId === fromVaultId &&
            d.existsOnDisk &&
            d.bufferContent !== d.savedContent &&
            NOTE_FILE.test(d.path),
        )
        .map((d) => ({ path: d.path, content: d.bufferContent })),
    };

    let preview: RenameLinksPreview;
    try {
      preview = await this.vault.previewRename(request);
    } catch {
      // The preview is a courtesy; a vault it cannot scan still renames.
      preview = { files: [], assets: [] };
    }
    if (preview.files.length === 0 && preview.assets.length === 0) {
      return this.plainRename(fromVaultId, fromRel, toVaultId, toRel);
    }

    if (mode === 'ask') {
      const answer = await new Promise<{ choice: LinkUpdateChoice; dontAskAgain: boolean }>(
        (resolve) => this.pending.set({ fromRel, toRel, preview, resolve }),
      );
      this.pending.set(null);
      if (answer.choice === 'cancel') {
        return null;
      }
      if (answer.dontAskAgain) {
        void this.settings.setUpdateLinksOnRename(answer.choice === 'update' ? 'always' : 'never');
      }
      if (answer.choice === 'rename') {
        return this.plainRename(fromVaultId, fromRel, toVaultId, toRel);
      }
    }

    const result = await this.vault.renameWithLinks(request);
    this.editor.retargetTabs(docKey(fromVaultId, fromRel), docKey(toVaultId, toRel));
    for (const asset of result.assets) {
      if (asset.kind === 'move') {
        this.editor.retargetTabs(docKey(fromVaultId, asset.from), docKey(toVaultId, asset.to));
      }
    }
    for (const buffer of result.buffers) {
      this.editor.updateBuffer(docKey(fromVaultId, buffer.path), buffer.content);
    }
    await this.editor.reloadFromVaultChange(fromVaultId, result.written);
    if (result.failed.length > 0) {
      void this.dialogs.message({
        title: 'Some links could not be updated',
        message: result.failed.join('\n'),
      });
    }
    return result.path;
  }

  /** The dialog's buttons. */
  answer(choice: LinkUpdateChoice, dontAskAgain: boolean): void {
    this.pending()?.resolve({ choice, dontAskAgain });
  }

  private async plainRename(
    fromVaultId: string,
    fromRel: string,
    toVaultId: string,
    toRel: string,
  ): Promise<string> {
    const next = await this.vault.renameEntry(fromRel, toRel, fromVaultId, toVaultId);
    this.editor.retargetTabs(docKey(fromVaultId, fromRel), docKey(toVaultId, toRel));
    return next;
  }
}
