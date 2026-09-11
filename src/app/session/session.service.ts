import { Injectable, effect, inject } from '@angular/core';
import { DocKindRegistry } from '../plugin-host';
import { PaneLayoutSnapshot, PaneService } from '../panes';
import { EditorService } from '../services/editor.service';
import { LogService } from '../services/log.service';
import { VaultService } from '../vault';

/**
 * One persisted open tab. The `text` / `image` members are the base kinds
 * (a text tab with nothing on disk to reload from -- a never-saved scratch
 * buffer, or unsaved edits to a real file -- carries a `backupId`, the name
 * of its content file under `<userData>/session-backups/`, ADR-0043). Any
 * other kind is a registered doc kind (ADR-0044 stage 8A): its owner's
 * `serialize`/`restore` answer the payload, and a kind that is not
 * registered at restore time closes silently.
 */
export type SessionTab =
  | { path: string; kind: 'text'; onDisk: boolean; backupId?: string }
  | { path: string; kind: 'image' }
  | { path: string; kind: string; data: unknown };

export interface SessionSnapshot {
  version: 1;
  savedAt: number;
  /** The vault these paths are relative to -- restore is skipped if it changed. */
  vault: string | null;
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
          this.flushBackups();
        }
      });
    }
  }

  /**
   * Rebuilds the previous session. Returns `true` when at least one tab was
   * restored, so `App` can skip its "open today's note" fallback.
   */
  async restore(): Promise<boolean> {
    let restoredAny = false;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
      const snap = raw ? (JSON.parse(raw) as SessionSnapshot) : null;
      if (
        snap &&
        snap.version === 1 &&
        Array.isArray(snap.tabs) &&
        snap.tabs.length > 0 &&
        snap.vault === this.vault.activeVaultPath()
      ) {
        this.restoring = true;
        const restoredPaths = new Set<string>();
        for (const tab of snap.tabs) {
          if (await this.restoreTab(tab)) {
            restoredPaths.add(tab.path);
          }
        }
        restoredAny = this.panes.restore(snap.layout, (p) => restoredPaths.has(p));
      }
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
    if (tab.kind === 'image') {
      await this.editor.openFile(tab.path);
      return this.editor.openDocs().some((d) => d.path === tab.path);
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
        await this.editor.openFile(tab.path);
        const open = this.editor.openDocs().some((d) => d.path === tab.path);
        if (open && backup != null) {
          // Re-apply the unsaved edits over the freshly-read disk content.
          this.editor.updateBuffer(tab.path, backup.replace(/\r\n/g, '\n'));
          if (tab.backupId) {
            this.backupIds.set(tab.path, tab.backupId);
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
        this.backupIds.set(tab.path, tab.backupId);
        this.written.add(tab.backupId);
      }
      return true;
    }
    return false; // a text tab never carries `data` -- unreachable
  }

  // --- persistence ---------------------------------------------------

  private buildSnapshot(): SessionSnapshot {
    const layout = this.panes.snapshot();
    const paths = new Set<string>();
    for (const id of Object.keys(layout.panes)) {
      for (const p of layout.panes[id].tabs) {
        paths.add(p);
      }
    }
    const tabs: SessionTab[] = [];
    for (const path of paths) {
      const doc = this.editor.docFor(path);
      if (!doc) {
        continue;
      }
      if (doc.kind === 'image') {
        tabs.push({ path, kind: 'image' });
      } else if (doc.kind !== 'text') {
        // A registered doc kind: its owner answers the payload. A kind that
        // lost its contribution (plugin disabled mid-session) is skipped --
        // nothing could restore it.
        const contrib = this.docKinds.get(doc.kind);
        if (contrib === undefined) {
          continue;
        }
        try {
          tabs.push({ path, kind: doc.kind, data: contrib.serialize(path) });
        } catch (error) {
          this.log.record('error', `doc kind "${doc.kind}" serialize failed: ${String(error)}`);
        }
      } else {
        const needsBackup = !doc.existsOnDisk || doc.bufferContent !== doc.savedContent;
        let backupId: string | undefined;
        if (needsBackup) {
          backupId = this.backupIds.get(path) ?? crypto.randomUUID();
          this.backupIds.set(path, backupId);
        } else {
          this.backupIds.delete(path);
        }
        tabs.push({ path, kind: 'text', onDisk: doc.existsOnDisk, backupId });
      }
    }
    return {
      version: 1,
      savedAt: Date.now(),
      vault: this.vault.activeVaultPath(),
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
    this.backupTimer = setTimeout(() => this.flushBackups(), BACKUP_DEBOUNCE);
  }

  private flushBackups(): void {
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
    if (!this.api) {
      return;
    }
    const live = new Set<string>();
    for (const [path, id] of this.backupIds) {
      const doc = this.editor.docFor(path);
      if (!doc || doc.kind !== 'text') {
        continue;
      }
      live.add(id);
      void this.api.writeSessionBackup(id, doc.bufferContent);
      this.written.add(id);
    }
    // Drop backup files no tab needs any more (saved, or closed).
    const stale = [...this.written].filter((id) => !live.has(id));
    if (stale.length > 0) {
      void this.api.deleteSessionBackups(stale);
      for (const id of stale) {
        this.written.delete(id);
      }
    }
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
