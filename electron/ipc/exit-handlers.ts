import { ipcMain } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DraftSaveRequest, ExitDecision, IPC_CHANNELS, NoteSaveResult } from '../../shared/ipc-api';
import { logLine } from '../logger';
import { NoteManager } from '../note-manager';
import { VaultManager } from '../vault-manager';
import { ExitBridge } from './exit-bridge';

/**
 * The hidden vault folder exit-time draft saves land in (bug-5, the
 * Notepad++ model): a dot-folder, so `VaultManager.listFiles` (which skips
 * dot-entries) keeps it out of the Files panel and the plugins' indexes.
 */
const DRAFTS_DIR = '.drafts';

export interface ExitHandlerDeps {
  vaultManager: VaultManager;
  noteManager: NoteManager;
  exitBridge: ExitBridge;
}

/**
 * Exit-confirm + untitled-draft IPC (bug-5): the renderer's answer to an
 * `exit:confirm-request`, and the `draft:save` channel that commits an
 * untitled buffer into `<vault>/.drafts/unnamed-N.md` without a Save-As
 * dialog -- only an explicit manual save asks for a location.
 */
export function registerExitHandlers({
  vaultManager,
  noteManager,
  exitBridge,
}: ExitHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.exitDecision, (_event, id: number, decision: ExitDecision): void => {
    exitBridge.resolveDecision(id, decision);
  });

  // Readiness handshake for the exit bridge: the preload fires this exactly
  // when the renderer's exit listener exists, so a close that raced app
  // startup replays its held request instead of losing it.
  ipcMain.handle(IPC_CHANNELS.exitListenerReady, () => {
    exitBridge.onRendererReady();
  });

  ipcMain.handle(
    IPC_CHANNELS.draftSave,
    async (_event, request: DraftSaveRequest): Promise<NoteSaveResult> => {
      const vaultRoot = vaultManager.getActiveVaultPath();
      if (!vaultRoot) {
        throw new Error('No active vault -- cannot save an untitled draft.');
      }
      const dir = path.join(vaultRoot, DRAFTS_DIR);
      await fsp.mkdir(dir, { recursive: true });
      // Continue past the highest existing index rather than reusing the
      // first gap: an externally deleted `unnamed-2.md` must not make the
      // next save collide with a tab still holding that path open.
      let max = 0;
      for (const name of await fsp.readdir(dir)) {
        const match = /^unnamed-(\d+)\.md$/.exec(name);
        if (match) {
          max = Math.max(max, Number(match[1]));
        }
      }
      const relPath = `${DRAFTS_DIR}/unnamed-${max + 1}.md`;
      // The regular note-save pipeline (frontmatter bump, hooks) minus the
      // on-save Actions -- no LLM round trips while the app is exiting.
      const result = await noteManager.saveNote({
        path: relPath,
        body: request.body,
        eol: request.eol ?? '\n',
        runOnSaveActions: false,
      });
      logLine(`[main/draft] untitled buffer committed as ${relPath}`);
      return result;
    },
  );
}
