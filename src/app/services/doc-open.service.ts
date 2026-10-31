import { Injectable, inject, signal } from '@angular/core';
import { imageExtension, pdfExtension } from '../../../shared/asset-name';
import { dailyPathFor } from '../../../shared/daily';
import { externalDocumentExtension } from '../../../shared/external-document';
import { externalDocKey } from '../../../shared/external-open';
import type { DocSplit } from '../../../shared/plugin-api/renderer';
import { EditorPrefsService } from '../editor/editor-prefs.service';
import { PaneService } from '../panes/pane.service';
import { VaultService } from '../vault';
import { FileOpenerRegistry } from './file-opener-registry.service';
import {
  OpenDoc,
  baseName,
  docKey,
  helpDoc,
  isReplaceable,
  pluginDoc,
  splitEol,
  textDoc,
  viewerDoc,
} from './open-doc';
import { OpenDocsStore } from './open-docs.store';
import { SettingsService } from './settings.service';

/**
 * Opens documents as tabs: vault files by kind (plugin opener, external
 * program, image, PDF, text), files outside any vault, daily notes,
 * scratch and help tabs -- and decides which tab an open replaces
 * (milestone 32) and which tabs are pinned against that.
 */
@Injectable({ providedIn: 'root' })
export class DocOpenService {
  private readonly store = inject(OpenDocsStore);
  private readonly vault = inject(VaultService);
  private readonly panes = inject(PaneService);
  private readonly prefs = inject(EditorPrefsService);
  private readonly settings = inject(SettingsService);
  private readonly fileOpeners = inject(FileOpenerRegistry);

  /** id + target for `openFileAt`; `id === 0` means "nothing pending". */
  readonly revealRequest = signal<{ id: number; key: string; line: number }>({
    id: 0,
    key: '',
    line: 1,
  });

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /**
   * Opens a file in a tab. `vaultId` defaults to the active vault. If it's
   * already open, just activates that tab. Never prompts -- a dirty buffer
   * for another file stays in memory.
   *
   * Tab replacement (milestone 32): when the new file opens, the focused
   * pane's *clean* active tab is closed with it -- following documents
   * replaces the view instead of accumulating tabs. A dirty focused tab
   * stays and the new file opens alongside. Only file-view kinds qualify
   * (see {@link replacedTabCandidate}); the already-open reveal path never
   * closes anything, and a failed read keeps the tab. Internal composition
   * flows pass `keepFocused: true`: the session restore reopens the whole
   * saved tab set, `saveAs` swaps the tab itself, and the Files panel's
   * multi-select open replaces only on its first call.
   *
   * `prefetched` (milestone 61): a file read already in flight (the
   * session restore fires all of its reads in parallel) — the content is
   * used as-is instead of a second read. The raw (CRLF-intact) content,
   * exactly as `readVaultFile` would return it.
   *
   * `pinned`: the new tab is pinned right away (the Files tree's
   * "Open in new tab") -- never the tab another open replaces, and the pin
   * rides the session snapshot. An already-open tab is revealed and pinned.
   *
   * `split` (SDK 1.35): the tab lands in a fresh split pane beside
   * (`'right'`) or below (`'down'`) the focused pane's content instead of
   * inside it. An already-open tab still just reveals (one pane per
   * document), and a focused dock band cannot split (ADR-0038) -- the tab
   * opens there plainly. A split-open never replaces the focused pane's
   * clean tab (it asked to open ALONGSIDE), and a file a plugin opener
   * claims (or an external document) ignores the option: no base tab is
   * added on those paths.
   *
   * `beside` (SDK 1.37): an open tab's path identity (resolved like
   * `documents.get`). Its pane takes focus BEFORE the landing decision,
   * so the replaced-tab victim is picked from that pane and a plain open
   * lands inside it; with `split`, the fresh pane opens off it. An anchor
   * that is not open is a no-op -- the focused pane decides, as before.
   */
  async openFile(
    relativePath: string,
    vaultId?: string,
    opts: {
      keepFocused?: boolean;
      prefetched?: { content: string; modifiedMs: number };
      pinned?: boolean;
      split?: DocSplit;
      beside?: string;
    } = {},
  ): Promise<void> {
    if (!this.api) {
      return;
    }
    // The anchor pane takes focus first: everything below (the victim
    // pick, the plain add, the split) then addresses that pane, never
    // whatever happened to be focused when the call came in.
    this.focusAnchor(opts.beside);
    // A split-open is an explicit "alongside" request: the focused pane's
    // clean tab is never replaced (with it, the pre-split pane would
    // collapse out of the layout again).
    const victim = opts.keepFocused === true || opts.split !== undefined ? null : this.replacedTabCandidate();
    const pin = opts.pinned === true ? { pinned: true } : {};
    const resolvedVault = vaultId ?? this.vault.activeVaultId();
    const key = docKey(resolvedVault, relativePath);
    if (this.store.has(key)) {
      // Already open -- reveal it (focus + activate whichever pane has it;
      // a document lives in one pane at a time, see `PaneService`). A pin
      // request still applies ("Open in new tab" on an already-open file
      // means reveal + pin -- the "keep this one" intent lands either way).
      this.panes.open(key);
      if (opts.pinned === true) {
        this.setPinned(key, true);
      }
      return;
    }

    // A plugin that claims this name suffix opens it as its own doc kind
    // (SDK 1.16, ADR-0064) -- asked first, because `.drawio.svg` would
    // otherwise be an image.
    if (this.fileOpeners.open(relativePath, resolvedVault)) {
      this.closeReplacedTab(victim);
      return;
    }

    // An Office document (or another type on the allowlist) opens in its
    // own program, not in a tab (ADR-0066) -- so no tab is replaced either.
    if (externalDocumentExtension(relativePath)) {
      try {
        await this.api.openVaultFileExternally(relativePath, resolvedVault ?? undefined);
      } catch (err) {
        this.store.fail(err);
      }
      return;
    }

    // The split lands first: everything below registers the new tab, and
    // a new tab always opens in the FOCUSED pane (`OpenDocsStore.add`) --
    // which `splitPane` just made the fresh sibling.
    this.splitLanding(opts.split);

    // An image file opens as a viewer tab -- never read as text (that used
    // to open a mojibake buffer that Ctrl+S would write back). Same for a
    // PDF (ADR-0052): the built-in (PDFium) viewer tab.
    const viewerKind = imageExtension(relativePath) ? 'image' : pdfExtension(relativePath) ? 'pdf' : null;
    if (viewerKind !== null) {
      this.store.add({ ...viewerDoc(viewerKind, relativePath, resolvedVault), ...pin });
      this.closeReplacedTab(victim);
      return;
    }

    this.store.isLoading.set(true);
    this.store.error.set(null);
    try {
      const { content, modifiedMs } =
        opts.prefetched ??
        (await this.api.readVaultFile(relativePath, resolvedVault ?? undefined));
      this.store.add({
        ...this.makeDoc(relativePath, resolvedVault, content, modifiedMs, true),
        ...pin,
      });
      this.closeReplacedTab(victim);
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.store.isLoading.set(false);
    }
  }

  /**
   * Opens `relativePath` and asks the editor to put the caret at the start
   * of 1-based `line` (a tag-search hit lands here). The `Editor` component
   * consumes `revealRequest` once the buffer for that document is loaded.
   * `opts.split` lands the tab in a fresh split pane, `opts.beside` anchors
   * the landing on an open tab's pane (see {@link openFile}).
   */
  async openFileAt(
    relativePath: string,
    line: number,
    vaultId?: string,
    opts?: { split?: DocSplit; beside?: string },
  ): Promise<void> {
    await this.openFile(relativePath, vaultId, opts);
    const key = docKey(vaultId ?? this.vault.activeVaultId(), relativePath);
    if (this.store.has(key)) {
      this.revealRequest.update((r) => ({ id: r.id + 1, key, line }));
    }
  }

  /**
   * Opens a file the OS handed to Drey that sits in NO registered vault
   * (ADR-0054): a pinned, editable tab keyed `external://<path>` that saves
   * back to that path. Main only serves the read (and write) for paths it
   * collected from the OS itself. Already open
   * -> just reveal it. Being pinned, it is never the tab another file
   * replaces, and opening it never replaces the focused tab either.
   */
  async openExternalFile(absolutePath: string): Promise<void> {
    if (!this.api) {
      return;
    }
    const key = externalDocKey(absolutePath);
    if (this.store.has(key)) {
      this.panes.open(key);
      return;
    }
    this.store.isLoading.set(true);
    this.store.error.set(null);
    try {
      const { content, modifiedMs } = await this.api.readExternalFile(absolutePath);
      const doc = this.makeDoc(absolutePath, null, content, modifiedMs, true);
      this.store.add({
        ...doc,
        key,
        name: baseName(absolutePath.replace(/\\/g, '/')),
        external: true,
        pinned: true,
      });
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.store.isLoading.set(false);
    }
  }

  /**
   * Opens (or replaces) an unsaved **draft** tab at `path` holding
   * arbitrary generated content -- e.g. the tag-search results document.
   * Nothing hits disk until the user saves it. The tab is **dirty from the
   * start** (`savedContent` empty) so the Save button is live without a
   * throwaway edit first; `save()` routes it to `saveAs()` (`askOnSave`).
   */
  openScratch(path: string, content: string): void {
    const normalized = splitEol(content).text;
    if (this.store.has(path)) {
      this.store.patch(path, {
        savedContent: '',
        bufferContent: normalized,
        existsOnDisk: false,
        askOnSave: true,
      });
      this.panes.open(path);
      return;
    }
    const doc = this.makeDoc(path, null, normalized, 0, false, true);
    this.store.add({ ...doc, savedContent: '' });
  }

  /**
   * File -> "New note". Opens a blank scratch tab; the first save prompts
   * for a location inside the vault (`askOnSave`).
   */
  newUntitled(): void {
    let name = 'untitled.md';
    let n = 2;
    while (this.store.has(name)) {
      name = `untitled-${n++}.md`;
    }
    this.openScratch(name, '');
  }

  /**
   * Opens the in-app help document at `path` (its own vault-less key, so
   * `help/manual.md` cannot collide with a vault tab) under the tab title
   * `name`, read-only and pinned (see `OpenDoc.help`, ADR-0070). Clean by
   * construction, so close/save/exit never prompt. An already-open tab is
   * revealed and its content refreshed (a re-fetch after an app update).
   */
  openHelpDoc(path: string, name: string, content: string, assetBase = ''): void {
    const normalized = splitEol(content).text;
    if (this.store.has(path)) {
      this.store.patch(path, { savedContent: normalized, bufferContent: normalized });
      this.panes.open(path);
      return;
    }
    this.store.add(helpDoc(path, name, normalized, assetBase));
  }

  /**
   * Opens the daily note for `dateStr` (`YYYY-MM-DD`) in the ACTIVE vault,
   * under the configured daily folder (`AppConfig.daily.dir`, default
   * `daily/`). If the file exists -- nested, or as a legacy flat file
   * inside that folder -- it's opened normally; otherwise a **draft** tab
   * is opened from the template -- nothing hits disk until the user types
   * and saves. Whatever an older folder setting wrote is never read here.
   *
   * Same tab replacement as {@link openFile}: clicking through the calendar
   * follows days instead of accumulating one clean tab per day.
   */
  async openDailyNote(dateStr: string): Promise<void> {
    if (!this.api) {
      return;
    }
    const victim = this.replacedTabCandidate();
    const vaultId = this.vault.activeVaultId();
    const dir = this.settings.dailyDir();
    const nestedPath = dailyPathFor(dateStr, dir);
    const legacyPath = `${dir}/${dateStr}.md`;
    // A note this session may already be open under either layout.
    for (const candidate of [nestedPath, legacyPath]) {
      const key = docKey(vaultId, candidate);
      if (this.store.has(key)) {
        this.panes.open(key);
        return;
      }
    }

    this.store.isLoading.set(true);
    this.store.error.set(null);
    try {
      // Prefer the nested layout; fall back to a pre-existing flat file;
      // otherwise open an unsaved draft at the nested path.
      const existing =
        (await this.tryReadDaily(nestedPath, vaultId)) ??
        (await this.tryReadDaily(legacyPath, vaultId));
      if (existing) {
        this.store.add(this.makeDoc(existing.path, vaultId, existing.content, existing.modifiedMs, true));
      } else {
        const template = await this.api.buildDailyNoteContent(dateStr);
        this.store.add(this.makeDoc(nestedPath, vaultId, template, 0, false));
      }
      this.closeReplacedTab(victim);
    } catch (err) {
      this.store.fail(err);
    } finally {
      this.store.isLoading.set(false);
    }
  }

  /**
   * Registers a tab of a registered (plugin or core) doc kind
   * (`DocKindRegistry`). The kind's owner mints the key (`browser://<n>`
   * for browser tabs) and owns everything behind it -- the view, the
   * chrome state, the favicon/status slots; the base only tracks the tab's
   * existence and its display name. No buffer, never dirty, never saved.
   * `split` (SDK 1.35) lands the tab in a fresh split pane beside or below
   * the focused pane; an already-open key still just reveals.
   * `beside` (SDK 1.37) anchors the landing on an open tab's pane (see
   * {@link openFile}): its pane is focused before the tab is added.
   */
  addPluginDoc(kind: string, key: string, name: string, opts: { split?: DocSplit; beside?: string } = {}): void {
    if (this.store.has(key)) {
      this.panes.open(key);
      return;
    }
    this.focusAnchor(opts.beside);
    this.splitLanding(opts.split);
    this.store.add(pluginDoc(kind, key, name));
  }

  /**
   * Focuses the pane of the `beside` anchor (SDK 1.37): an open tab's
   * path identity -- a vault-relative path or a contributed key like
   * `thread://ticket`, resolved like `documents.get`. Everything the
   * caller does next (the victim pick, a plain add, a split) then lands
   * relative to that pane. An anchor that is not open is a no-op: the
   * focused pane stays, exactly as before the option existed.
   */
  private focusAnchor(beside: string | undefined): void {
    if (beside === undefined) {
      return;
    }
    const anchor = this.store.resolveDoc(beside);
    const paneId = anchor === null ? null : this.panes.paneIdFor(anchor.key);
    if (paneId !== null) {
      this.panes.focus(paneId);
    }
  }

  /**
   * Lands the next registered tab in a fresh split: splits the focused
   * pane (the new sibling becomes focused, and `OpenDocsStore.add` always
   * opens into the focused pane), so the tab the caller adds next opens
   * there. `PaneService.splitPane` refuses a docked pane (ADR-0038) and a
   * missing focus -- both fall back to the plain open, by returning before
   * anything is split.
   */
  private splitLanding(split: DocSplit | undefined): void {
    if (split === undefined) {
      return;
    }
    const focused = this.panes.focusedPane();
    if (focused === null) {
      return;
    }
    this.panes.splitPane(focused.id, split === 'down' ? 'column' : 'row');
  }

  /** Pins / unpins a tab; a no-op for a key that is not open. */
  togglePin(key: string): void {
    const doc = this.store.docFor(key);
    // An external tab is permanently pinned (ADR-0054).
    if (doc !== null && doc.external !== true) {
      this.store.patch(key, { pinned: doc.pinned !== true });
    }
  }

  /** Session restore: re-applies a persisted pin. */
  setPinned(key: string, pinned: boolean): void {
    if (this.store.has(key)) {
      this.store.patch(key, { pinned });
    }
  }

  /**
   * The tab opening another file may replace: the focused pane's active
   * tab if it qualifies (see `isReplaceable`), else -- when the active tab
   * is **pinned** -- the pane's rightmost tab that does. A pinned tab stays
   * (the user asked for it to stay) and hands the replacement to an
   * unpinned neighbour, so browsing from a pinned reference note reuses
   * the "preview" slot rather than piling up tabs. A dirty or plugin
   * *active* tab does not delegate: the new file opens alongside, as
   * before. `null` when nothing is focused or nothing qualifies.
   */
  private replacedTabCandidate(): string | null {
    const pane = this.panes.focusedPane();
    const active = this.store.docFor(pane?.active ?? null);
    if (pane === null || active === null) {
      return null;
    }
    if (active.pinned !== true) {
      return isReplaceable(active) ? active.key : null;
    }
    for (const key of [...pane.tabs].reverse()) {
      const doc = this.store.docFor(key);
      if (doc !== null && isReplaceable(doc)) {
        return key;
      }
    }
    return null;
  }

  /**
   * Closes the tab captured by {@link replacedTabCandidate} -- after the
   * new file is safely open. Re-checks cleanliness: if the buffer turned
   * dirty while the read was in flight (the user typed into it), the tab
   * stays, per the same rule that never closes a dirty tab.
   */
  private closeReplacedTab(victim: string | null): void {
    const doc = this.store.docFor(victim);
    if (doc !== null && isReplaceable(doc)) {
      this.store.remove(doc.key);
    }
  }

  private makeDoc(
    relativePath: string,
    vaultId: string | null,
    rawContent: string,
    modifiedMs: number,
    existsOnDisk: boolean,
    askOnSave = false,
  ): OpenDoc {
    return textDoc(
      relativePath,
      vaultId,
      rawContent,
      modifiedMs,
      existsOnDisk,
      this.prefs.defaultMode(),
      askOnSave,
    );
  }

  private async tryReadDaily(
    path: string,
    vaultId: string | null,
  ): Promise<{ path: string; content: string; modifiedMs: number } | null> {
    try {
      const { content, modifiedMs } = await this.api!.readVaultFile(path, vaultId ?? undefined);
      return { path, content, modifiedMs };
    } catch {
      return null;
    }
  }
}
