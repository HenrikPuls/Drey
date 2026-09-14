import { Injectable, effect, inject } from '@angular/core';
import { DocKindRegistry } from '../plugin-host';
import { PaneLayoutSnapshot, PaneService } from '../panes';
import { EditorService, docKey } from '../services/editor.service';
import { LogService } from '../services/log.service';
import { VaultService } from '../vault';

/**
 * One persisted open tab. `vaultId` is the tab's vault (ADR-0051; null for
 * vault-less docs -- a scratch tab or a registered doc kind, whose `path`
 * IS its synthetic key). The `text` / `image` members are the base kinds
 * (a text tab with nothing on disk to reload from -- a never-saved scratch
 * buffer, or unsaved edits to a real file -- carries a `backupId`, the name
 * of its content file under `<userData>/session-backups/`, ADR-0043). Any
 * other kind is a registered doc kind (ADR-0044 stage 8A): its owner's
 * `serialize`/`restore` answer the payload, and a kind that is not
 * registered at restore time closes silently -- as is a tab whose vault is
 * no longer registered.
 */
export type SessionTab =
  | { vaultId: string | null; path: string; kind: 'text'; onDisk: boolean; backupId?: string }
  | { vaultId: string | null; path: string; kind: 'image' }
  | { vaultId: string | null; path: string; kind: 'pdf' }
  | { vaultId: null; path: string; kind: string; data: unknown };

export interface SessionSnapshot {
  version: 2;
  savedAt: number;
  layout: PaneLayoutSnapshot;
  tabs: SessionTab[];
}

const KEY = 'drey.session';
const LAYOUT_DEBOUNCE = 400;
const BACKUP_DEBOUNCE = 700;

/**
 * Restores the editor to the exact layout it had on the previous launch
 * (ADR-0043): the pane split tree, which tabs sit in which pane, the active
 * tab, the focused pane -- and the *content* of tabs that were never saved
 * anywhere, Notepad++-style.
 *
 * The layout + tab list is small per-machine window state, so it lives in
 * `localStorage['drey.session']` next to the dock layout. Only unsaved
 * buffer text needs a real file (it can be large and must not be lost); the
 * main process keeps those under `<userData>/session-backups/`.
 *
 * `App` calls `restore()` once at startup, after the vault and config are
 * known and before the "open today's note" fallback. Persistence then runs
 * off a single effect for the rest of the session.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly editor = inject(EditorService);
  private readonly panes = inject(PaneService);
  private readonly docKinds = inject(DocKindRegistry);
  private readonly vault = inject(VaultService);
  private readonly log = inject(LogService);

  /** path -> backup id, for tabs whose text is only in a backup file. */
  private readonly backupIds = new Map<string, string>();
  /** Backup ids currently written to disk -- diffed each save to prune stale ones. */
  private written = new Set<string>();

  private ready = false;
  private restoring = false;
  private layoutTimer: ReturnType<typeof setTimeout> | null = null;
  private backupTimer: ReturnType<typeof setTimeout> | null = null;

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  constructor() {
    // One subscription to everything that defines "the session": the open
    // documents (buffers, dirty state, kind) and the pane layout. It no-ops
    // until `restore()` has run so the initial re-open doesn't thrash the
    // store.
    effect(() => {
      this.editor.openDocs();
      this.panes.snapshot();
      if (!this.ready || this.restoring) {
        return;
      }
      this.scheduleLayoutSave();
      this.scheduleBackupSave();
    });

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.saveLayoutNow());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.saveLayoutNow();
          void this.flushBackups();
        }
      });
    }
  }

  /**
   * Rebuilds the previous session. Returns `true` when at least one tab was
   * restored, so `App` can skip its "open today's note" fallback.
   *
   * v2 snapshots are per-tab (`vaultId` on each): a tab whose vault is no
   * longer registered is dropped, the rest restore. v1 snapshots (one
   * global `vault` path) still restore the old way -- all tabs mapped to
   * the ACTIVE vault, and only when that path still matches; this bridge
   * can go one release after ADR-0051 ships.
   */
  async restore(): Promise<boolean> {
    let restoredAny = false;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
      const parsed = raw ? (JSON.parse(raw) as Partial<SessionSnapshot> & { vault?: unknown }) : null;
      if (!parsed || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0 || !parsed.layout) {
        return false;
      }
      let tabs: SessionTab[];
      let layout: SessionSnapshot['layout'] = parsed.layout;
      if (parsed.version === 2) {
        tabs = parsed.tabs as SessionTab[];
      } else if (parsed.version === 1 && parsed.vault === this.vault.activeVaultPath()) {
        // v1: on-disk paths were relative to the one vault -- the active
        // one. Scratch tabs (onDisk: false) and doc-kind tabs were
        // vault-less even then, so only the on-disk ones get re-keyed into
        // the vault's namespace -- tabs AND the layout's tab strings.
        const activeVaultId = this.vault.activeVaultId();
        if (activeVaultId === null || !layout) {
          return false;
        }
        const raw = parsed.tabs as Array<{ kind: string; path: string; onDisk?: boolean }>;
        const scratchPaths = new Set(
          raw.filter((t) => t.kind === 'text' && t.onDisk === false).map((t) => t.path),
        );
        tabs = raw.map((t) => ({
          ...t,
          vaultId: t.kind === 'text' && t.onDisk === false ? null : activeVaultId,
        })) as SessionTab[];
        const rekey = (p: string): string =>
          scratchPaths.has(p) ? p : docKey(activeVaultId, p);
        layout = {
          ...layout,
          panes: Object.fromEntries(
            Object.entries(layout.panes).map(([id, pane]) => [
              id,
              {
                ...pane,
                tabs: pane.tabs.map(rekey),
                active: pane.active !== null ? rekey(pane.active) : null,
              },
            ]),
          ),
        };
      } else {
        return false;
      }

      this.restoring = true;
      const restoredKeys = new Set<string>();
      for (const tab of tabs) {
        // A tab whose vault vanished (deregistered since) closes silently,
        // exactly like an unregistered doc kind.
        if (tab.vaultId !== null && !this.vault.vaults().some((v) => v.id === tab.vaultId)) {
          continue;
        }
        if (await this.restoreTab(tab)) {
          restoredKeys.add(docKey(tab.vaultId, tab.path));
        }
      }
      restoredAny = this.panes.restore(layout, (p) => restoredKeys.has(p));
    } catch {
      // A corrupt session file must never block startup.
    } finally {
      this.restoring = false;
      this.ready = true;
      void this.pruneOrphanBackups();
    }
    return restoredAny;
  }

  private async restoreTab(tab: SessionTab): Promise<boolean> {
    const key = docKey(tab.vaultId, tab.path);
    if (tab.kind === 'image' || tab.kind === 'pdf') {
      await this.editor.openFile(tab.path, tab.vaultId ?? undefined);
      return this.editor.openDocs().some((d) => d.key === key);
    }
    if (tab.kind !== 'text') {
      // A registered doc kind (ADR-0044): its owner recreates the tab from
      // the payload. Unregistered kinds (a plugin disabled since) close
      // silently. Snapshots written before the registry carried the
      // payload at the top level -- the browser tab's `url` -- so hand the
      // whole tab over; new snapshots carry it in `data`.
      const contrib = this.docKinds.get(tab.kind);
      if (contrib === undefined) {
        return false;
      }
      const data = 'data' in tab ? tab.data : tab;
      try {
        contrib.restore(tab.path, data);
        return true;
      } catch (error) {
        this.log.record('error', `doc kind "${tab.kind}" restore failed: ${String(error)}`);
        return false;
      }
    }

    // text (the `data`-carrying member is the doc-kind one; the `in` check
    // discriminates what the string-typed `kind` cannot)
    if (!('data' in tab)) {
      const backup = tab.backupId ? await this.api?.readSessionBackup(tab.backupId) : null;

      if (tab.onDisk) {
        await this.editor.openFile(tab.path, tab.vaultId ?? undefined);
        const open = this.editor.openDocs().some((d) => d.key === key);
        if (open && backup != null) {
          // Re-apply the unsaved edits over the freshly-read disk content.
          this.editor.updateBuffer(key, backup.replace(/\r\n/g, '\n'));
          if (tab.backupId) {
            this.backupIds.set(key, tab.backupId);
            this.written.add(tab.backupId);
          }
        }
        return open;
      }

      // never-saved scratch buffer -- only restorable from its backup
      if (backup == null) {
        return false;
      }
      this.editor.openScratch(tab.path, backup.replace(/\r\n/g, '\n'));
      if (tab.backupId) {
        this.backupIds.set(key, tab.backupId);
        this.written.add(tab.backupId);
      }
      return true;
    }
    return false; // a text tab never carries `data` -- unreachable
  }

  // --- persistence ---------------------------------------------------

  private buildSnapshot(): SessionSnapshot {
    const layout = this.panes.snapshot();
    const keys = new Set<string>();
    for (const id of Object.keys(layout.panes)) {
      for (const p of layout.panes[id].tabs) {
        keys.add(p);
      }
    }
    const tabs: SessionTab[] = [];
    for (const key of keys) {
      const doc = this.editor.docFor(key);
      if (!doc) {
        continue;
      }
      if (doc.kind === 'image') {
        tabs.push({ vaultId: doc.vaultId, path: doc.path, kind: 'image' });
      } else if (doc.kind === 'pdf') {
        tabs.push({ vaultId: doc.vaultId, path: doc.path, kind: 'pdf' });
      } else if (doc.kind !== 'text') {
        // A registered doc kind: its owner answers the payload. A kind that
        // lost its contribution (plugin disabled mid-session) is skipped --
        // nothing could restore it.
        const contrib = this.docKinds.get(doc.kind);
        if (contrib === undefined) {
          continue;
        }
        try {
          tabs.push({ vaultId: null, path: doc.path, kind: doc.kind, data: contrib.serialize(doc.path) });
        } catch (error) {
          this.log.record('error', `doc kind "${doc.kind}" serialize failed: ${String(error)}`);
        }
      } else {
        const needsBackup = !doc.existsOnDisk || doc.bufferContent !== doc.savedContent;
        let backupId: string | undefined;
        if (needsBackup) {
          backupId = this.backupIds.get(key) ?? crypto.randomUUID();
          this.backupIds.set(key, backupId);
        } else {
          this.backupIds.delete(key);
        }
        tabs.push({
          vaultId: doc.vaultId,
          path: doc.path,
          kind: 'text',
          onDisk: doc.existsOnDisk,
          backupId,
        });
      }
    }
    return {
      version: 2,
      savedAt: Date.now(),
      layout,
      tabs,
    };
  }

  private scheduleLayoutSave(): void {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
    }
    this.layoutTimer = setTimeout(() => this.saveLayoutNow(), LAYOUT_DEBOUNCE);
  }

  private saveLayoutNow(): void {
    if (this.layoutTimer) {
      clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.buildSnapshot()));
    } catch {
      // storage full / unavailable -- nothing we can do, don't crash typing
    }
  }

  private scheduleBackupSave(): void {
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
    }
    this.backupTimer = setTimeout(() => void this.flushBackups(), BACKUP_DEBOUNCE);
  }

  /**
   * Persists the layout + every dirty-buffer backup RIGHT NOW and waits for
   * the backup writes (bug-5): the exit flow awaits this before answering
   * "save" / "exit without saving", so the debounce window can't be lost to
   * the closing window.
   */
  async flushNow(): Promise<void> {
    this.saveLayoutNow();
    await this.flushBackups();
  }

  private async flushBackups(): Promise<void> {
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
    if (!this.api) {
      return;
    }
    const writes: Promise<unknown>[] = [];
    const live = new Set<string>();
    for (const [path, id] of this.backupIds) {
      const doc = this.editor.docFor(path);
      if (!doc || doc.kind !== 'text') {
        continue;
      }
      live.add(id);
      writes.push(this.api.writeSessionBackup(id, doc.bufferContent));
      this.written.add(id);
    }
    // Drop backup files no tab needs any more (saved, or closed).
    const stale = [...this.written].filter((id) => !live.has(id));
    if (stale.length > 0) {
      writes.push(this.api.deleteSessionBackups(stale));
      for (const id of stale) {
        this.written.delete(id);
      }
    }
    // allSettled: a failed backup write must not abort its siblings.
    await Promise.allSettled(writes);
  }

  /** On startup: delete backup files not referenced by the restored session. */
  private async pruneOrphanBackups(): Promise<void> {
    if (!this.api?.listSessionBackups) {
      return;
    }
    try {
      const onDisk = await this.api.listSessionBackups();
      const keep = new Set(this.backupIds.values());
      const orphans = onDisk.filter((id) => !keep.has(id));
      if (orphans.length > 0) {
        await this.api.deleteSessionBackups(orphans);
      }
    } catch {
      // best effort
    }
  }
}
