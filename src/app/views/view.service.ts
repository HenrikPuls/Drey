import { Injectable, computed, inject, signal } from '@angular/core';
import type { Unsubscribe, ViewPresetContrib } from '../../../shared/plugin-api/renderer';
import { DockService } from '../dock';
import { DEFAULT_VIEW_ID, PaneService } from '../panes/pane.service';
import { EditorService } from '../services/editor.service';
import { HomeViewRouter } from '../services/home-view-router.service';
import { LogService } from '../services/log.service';

/** One view: a named, saved layout (ADR-0089). */
export interface ViewDef {
  readonly id: string;
  readonly label: string;
  /** Built-in views (Notes) and plugin presets cannot be renamed or deleted by the user. */
  readonly builtin: boolean;
  /** The plugin that registered this view as a preset (SDK 1.39); absent for Notes and user views. */
  readonly pluginId?: string;
  /** The Assistant's default conversation target in this view (opaque to the host, SDK 1.39). */
  readonly assistantTarget?: string;
}

/** The name field of "Save current layout as a view…" / "Rename view…". */
export interface ViewNamePrompt {
  readonly mode: 'new' | 'rename';
  readonly viewId: string | null;
  readonly initial: string;
}

const KEY = 'drey.views';
const NOTES: ViewDef = { id: DEFAULT_VIEW_ID, label: 'Notes', builtin: true };

/**
 * The list of views and which one is active (ADR-0089). A view is a saved
 * layout: `DockService` holds its dock state, `PaneService` its pane tree
 * and tabs -- this service only names them, switches them together and
 * answers "which views show this document". Documents stay global in
 * `OpenDocsStore` (one document, one buffer); a view owns placements only.
 *
 * Notes is today's layout and always exists. Further views come from
 * "Save current layout as a view…" and from plugin presets (SDK 1.39,
 * `registerPreset`): the order is Notes, presets, user views. Only the user
 * views are listed in `localStorage['drey.views']` (small per-machine window
 * state, like the dock layout); a preset comes back from its plugin at every
 * start, and its layout waits in the dock/pane slots under its id.
 */
@Injectable({ providedIn: 'root' })
export class ViewService {
  private readonly dock = inject(DockService);
  private readonly panes = inject(PaneService);
  private readonly editor = inject(EditorService);
  private readonly homeViews = inject(HomeViewRouter);
  private readonly log = inject(LogService);

  private readonly user = signal<readonly ViewDef[]>(this.read());
  private readonly presets = signal<readonly (ViewDef & { readonly preset: ViewPresetContrib })[]>([]);
  readonly views = computed<readonly ViewDef[]>(() => [NOTES, ...this.presets(), ...this.user()]);
  private readonly _activeId = signal<string>(DEFAULT_VIEW_ID);
  readonly activeId = this._activeId.asReadonly();
  readonly active = computed<ViewDef>(
    () => this.views().find((v) => v.id === this._activeId()) ?? NOTES,
  );
  /** The active view's default Assistant target, or null (Notes, user views, presets without one). */
  readonly assistantTarget = computed<string | null>(() => this.active().assistantTarget ?? null);
  /** True from start until `settleStartup` while the stored active view might be a preset not yet registered. */
  private unsettled = false;

  /** The name field's request, shown by the title bar; null while closed. */
  readonly prompt = signal<ViewNamePrompt | null>(null);

  constructor() {
    // The dock layout remembers its own active view; a view that was
    // deleted since (or a damaged list) falls back to Notes.
    const stored = this.dock.activeViewId();
    if (this.views().some((v) => v.id === stored)) {
      this._activeId.set(stored);
      this.panes.setActiveViewId(stored);
    } else if (stored !== DEFAULT_VIEW_ID && !stored.startsWith('view-')) {
      // Possibly a plugin preset: its plugin registers it a moment from now.
      // `settleStartup` decides once the plugins are loaded.
      this._activeId.set(stored);
      this.panes.setActiveViewId(stored);
      this.unsettled = true;
    } else {
      this.dock.switchView(DEFAULT_VIEW_ID);
      this.panes.setActiveViewId(DEFAULT_VIEW_ID);
    }
    this.homeViews.attach((id) => this.switchTo(id));
  }

  /**
   * Called once the plugins have registered their presets (before the
   * session is restored): an active view that still does not exist -- its
   * plugin was disabled since -- falls back to Notes. Its saved layout is
   * kept in case the plugin comes back.
   */
  settleStartup(): void {
    if (!this.unsettled) {
      return;
    }
    this.unsettled = false;
    if (!this.views().some((v) => v.id === this._activeId())) {
      this.dock.switchView(DEFAULT_VIEW_ID);
      this.panes.switchView(DEFAULT_VIEW_ID);
      this._activeId.set(DEFAULT_VIEW_ID);
    }
  }

  // --- plugin presets (SDK 1.39) ---------------------------------------------

  /**
   * A plugin's view preset joins the switcher after Notes. A taken id is
   * refused (logged). The preset's first layout is applied when the view is
   * first shown, not now: its panels may belong to plugins that register
   * after this one. Disposing removes the view; if it was active the owner
   * lands in Notes.
   */
  registerPreset(pluginId: string, preset: ViewPresetContrib): Unsubscribe {
    const id = preset.id.trim();
    const label = preset.label.trim();
    if (id === '' || label === '' || this.views().some((v) => v.id === id)) {
      this.log.record('warn', `view preset "${preset.id}" of plugin "${pluginId}" refused: empty or taken id`);
      return () => undefined;
    }
    const entry = {
      id,
      label,
      builtin: true,
      pluginId,
      ...(preset.assistantTarget !== undefined ? { assistantTarget: preset.assistantTarget } : {}),
      preset,
    };
    this.presets.update((list) => [...list, entry]);
    return () => {
      if (this._activeId() === id) {
        this.switchTo(DEFAULT_VIEW_ID);
      }
      this.presets.update((list) => list.filter((p) => p !== entry));
    };
  }

  /** Switches the whole workspace: docks and panes together. */
  switchTo(id: string): void {
    if (id === this._activeId() || !this.views().some((v) => v.id === id)) {
      return;
    }
    const preset = this.presets().find((p) => p.id === id)?.preset;
    if (preset?.layout !== undefined) {
      this.dock.seedView(id, preset.layout);
    }
    this.dock.switchView(id);
    this.panes.switchView(id);
    this._activeId.set(id);
  }

  /** `Ctrl+1`…`Ctrl+9`: the view at 0-based `index`; a missing one does nothing. */
  switchToIndex(index: number): void {
    const view = this.views()[index];
    if (view !== undefined) {
      this.switchTo(view.id);
    }
  }

  /** The "Switch view" command: the next view, wrapping around. */
  switchToNext(): void {
    const views = this.views();
    if (views.length < 2) {
      return;
    }
    const at = views.findIndex((v) => v.id === this._activeId());
    this.switchTo(views[(at + 1) % views.length].id);
  }

  // --- the name field ------------------------------------------------------

  openSavePrompt(): void {
    this.prompt.set({ mode: 'new', viewId: null, initial: '' });
  }

  openRenamePrompt(id: string): void {
    const view = this.views().find((v) => v.id === id);
    if (view !== undefined && !view.builtin) {
      this.prompt.set({ mode: 'rename', viewId: id, initial: view.label });
    }
  }

  cancelPrompt(): void {
    this.prompt.set(null);
  }

  /** Applies the name field; an empty or already used name keeps the field open. */
  commitPrompt(value: string): boolean {
    const request = this.prompt();
    const label = value.trim();
    if (request === null || label === '' || this.labelTaken(label, request.viewId)) {
      return false;
    }
    if (request.mode === 'new') {
      this.saveCurrentAs(label);
    } else if (request.viewId !== null) {
      this.rename(request.viewId, label);
    }
    this.prompt.set(null);
    return true;
  }

  /** True when another view already carries `label` (case-insensitive). */
  labelTaken(label: string, exceptId: string | null = null): boolean {
    const wanted = label.trim().toLowerCase();
    return this.views().some((v) => v.id !== exceptId && v.label.toLowerCase() === wanted);
  }

  // --- the list --------------------------------------------------------------

  /**
   * "Save current layout as a view…": the new view starts as a copy of the
   * active one -- the same docks, panes and tabs (documents are shared, not
   * copied) -- and becomes the active view.
   */
  saveCurrentAs(label: string): string {
    const id = `view-${Date.now().toString(36)}-${this.views().length}`;
    this.dock.copyActiveTo(id);
    this.panes.cloneActiveViewTo(id);
    this.user.update((views) => [...views, { id, label: label.trim(), builtin: false }]);
    this.persist();
    this.switchTo(id);
    return id;
  }

  rename(id: string, label: string): void {
    this.user.update((views) => views.map((v) => (v.id === id ? { ...v, label: label.trim() } : v)));
    this.persist();
  }

  /**
   * Deletes a user view. A document that only this view held is closed
   * (asking about unsaved changes); one the user keeps open instead moves
   * to Notes -- a document held by no view cannot be open.
   */
  async remove(id: string): Promise<void> {
    const view = this.user().find((v) => v.id === id);
    if (view === undefined) {
      return;
    }
    if (this._activeId() === id) {
      this.switchTo(DEFAULT_VIEW_ID);
    }
    for (const key of this.panes.tabsOfView(id)) {
      if (this.panes.viewsHolding(key).length === 1) {
        const closed = await this.editor.closeTab(key);
        if (!closed) {
          this.panes.showInView(DEFAULT_VIEW_ID, key);
        }
      }
    }
    this.dock.dropView(id);
    this.panes.dropView(id);
    this.user.update((views) => views.filter((v) => v.id !== id));
    this.persist();
  }

  // --- tabs belong to views ---------------------------------------------------

  /** The views that show the tab `key`. */
  viewsOfTab(key: string): string[] {
    return this.panes.viewsHolding(key);
  }

  /**
   * "Show this tab in": ticks or unticks `viewId` for the tab. The last
   * view cannot be unticked -- that is "Close".
   */
  toggleTabIn(key: string, viewId: string): void {
    const holding = this.panes.viewsHolding(key);
    if (holding.includes(viewId)) {
      if (holding.length > 1) {
        this.panes.hideInView(viewId, key);
      }
    } else {
      this.panes.showInView(viewId, key);
    }
  }

  /** Open windows "Show here": the document joins the active view. */
  showHere(key: string): void {
    this.panes.showInView(this._activeId(), key);
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ views: this.user() }));
    } catch {
      // Storage disabled: the views last for this session.
    }
  }

  private read(): readonly ViewDef[] {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { views?: unknown };
        if (Array.isArray(saved.views)) {
          const user = saved.views.filter(
            (v): v is { id: string; label: string } =>
              typeof v === 'object' &&
              v !== null &&
              typeof (v as { id?: unknown }).id === 'string' &&
              typeof (v as { label?: unknown }).label === 'string' &&
              (v as { id: string }).id !== DEFAULT_VIEW_ID,
          );
          return user.map((v) => ({ id: v.id, label: v.label, builtin: false }));
        }
      }
    } catch {
      // A damaged list: no user views.
    }
    return [];
  }
}
