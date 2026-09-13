import { Injectable, inject } from '@angular/core';
import { EditorService } from '../services/editor.service';
import { VaultService } from '../vault';
import { PaneService } from './pane.service';

/**
 * Private DataTransfer type the Files panel / calendar put a dragged file's
 * TAB KEY on -- `${vaultId}::${relativePath}` (ADR-0051), the same composite
 * `EditorService.docKey` uses; a bare relative path from an older source is
 * still accepted and resolves against the active vault. Duplicated here
 * rather than imported across the editor module boundary --
 * `DropGuardService` hardcodes the same literal.
 */
const VAULT_PATH_DT_TYPE = 'application/x-drey-vault-path';

/**
 * Turns a file dropped onto a pane -- its tab strip, meta bar, empty state,
 * or the padding / gutter around the text, i.e. anywhere that is *not*
 * `.cm-content` -- into an open tab in that pane. `PaneLeaf` owns the
 * `dragover` / `drop` DOM events and delegates here (CLAUDE.md: logic in
 * services, not components).
 *
 * Scope (amends ADR-0027 / ADR-0028): a **vault file** only -- a Files-panel
 * / calendar drag (the `application/x-drey-vault-path` type) or an OS file
 * drag whose absolute path resolves inside the active vault root. A file
 * from outside the vault, a directory, or a URL-only / web-image drag is
 * left for `DropGuardService` to swallow: `Doc` is vault-relative
 * throughout (identity, save, re-index, tasks, `paneIdFor`), so opening an
 * arbitrary absolute path is a separate capability, not built here.
 */
@Injectable({ providedIn: 'root' })
export class PaneDropService {
  private readonly editor = inject(EditorService);
  private readonly panes = inject(PaneService);
  private readonly vault = inject(VaultService);

  /**
   * Coarse "this drag might open a file" test for the `dragover` cursor --
   * `DataTransfer.getData` is blank until `drop` (drag data store is in
   * protected mode), so only `types` is readable here.
   */
  canOpen(dt: DataTransfer | null): boolean {
    const types = Array.from(dt?.types ?? []);
    return types.includes(VAULT_PATH_DT_TYPE) || types.includes('Files');
  }

  /**
   * Opens the dropped file in `paneId`, focusing that pane first so the tab
   * lands there. Returns `true` if it acted, `false` if the transfer
   * carried nothing this service opens (an out-of-vault OS file, a URL).
   */
  async openFromDrop(paneId: string, dt: DataTransfer | null): Promise<boolean> {
    const target = this.resolvePath(dt);
    if (target === null) {
      return false;
    }
    this.panes.focus(paneId);
    await this.editor.openFile(target.path, target.vaultId ?? undefined);
    return true;
  }

  /** The vault file the transfer points at, or `null`. */
  private resolvePath(dt: DataTransfer | null): { vaultId: string | null; path: string } | null {
    if (!dt) {
      return null;
    }

    const tagged = dt.getData(VAULT_PATH_DT_TYPE).trim();
    if (tagged) {
      const normalised = normaliseRelative(tagged);
      // `${vaultId}::${path}` (ADR-0051) or a bare vault-relative path.
      const sep = normalised.indexOf('::');
      if (sep > 0) {
        const vaultId = normalised.slice(0, sep);
        if (this.vault.vaults().some((v) => v.id === vaultId)) {
          return { vaultId, path: normalised.slice(sep + 2) };
        }
      }
      return { vaultId: this.vault.activeVaultId(), path: normalised };
    }

    const root = this.vault.activeVaultPath();
    if (!root) {
      return null;
    }
    for (const file of Array.from(dt.files)) {
      const absolute = (file as File & { path?: string }).path ?? '';
      const relative = absolute ? relativeToRoot(absolute, root) : null;
      if (relative) {
        return { vaultId: this.vault.activeVaultId(), path: relative };
      }
    }
    return null;
  }
}


/** Back-slashes to `/`, no leading `/`, no doubled separators. */
function normaliseRelative(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

/**
 * `absolute` as a vault-relative forward-slash path if it sits inside
 * `root`, else `null`. A Windows-style root (drive letter) compares
 * case-insensitively; POSIX compares exactly.
 */
function relativeToRoot(absolute: string, root: string): string | null {
  const a = absolute.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const caseInsensitive = /^[a-zA-Z]:\//.test(r);
  const head = a.slice(0, r.length);
  const same = caseInsensitive ? head.toLowerCase() === r.toLowerCase() : head === r;
  if (!same || a[r.length] !== '/') {
    return null;
  }
  const rest = a.slice(r.length + 1);
  return rest ? normaliseRelative(rest) : null;
}
