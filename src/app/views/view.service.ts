import { Injectable, computed, inject, signal } from '@angular/core';
import { DockService } from '../dock';
import { DEFAULT_VIEW_ID, PaneService } from '../panes/pane.service';
import { EditorService } from '../services/editor.service';

/** One view: a named, saved layout (ADR-0089). */
export interface ViewDef {
  readonly id: string;
  readonly label: string;
  /** Built-in views (Notes) cannot be renamed away or deleted. */
  readonly builtin: boolean;
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
 * "Save current layout as a view…" (a plugin-contributed preset is the next
 * roadmap item, E13-2). The list of user views is small per-machine window
 * state in `localStorage['drey.views']`, like the dock layout.
 */
@Injectable({ providedIn: 'root' })
export class ViewService {
  private readonly dock = inject(DockService);
  private readonly panes = inject(PaneService);
  private readonly editor = inject(EditorService);

  private readonly _views = signal<readonly ViewDef[]>(this.read());
  readonly views = this._views.asReadonly();
  private readonly _activeId = signal<string>(DEFAULT_VIEW_ID);
  readonly activeId = this._activeId.asReadonly();
  readonly active = computed<ViewDef>(
    () => this._views().find((v) => v.id === this._activeId()) ?? NOTES,
  );

  /** The name field's request, shown by the title bar; null while closed. */
  readonly prompt = signal<ViewNamePrompt | null>(null);

  constructor() {
    // The dock layout remembers its own active view; a view that was
    // deleted since (or a damaged list) falls back to Notes.
    const stored = this.dock.activeViewId();
    if (this._views().some((v) => v.id === stored)) {
      this._activeId.set(stored);
      this.panes.setActiveViewId(stored);
    } else {
      this.dock.switchView(DEFAULT_VIEW_ID);
      this.panes.setActiveViewId(DEFAULT_VIEW_ID);
    }
  }

  /** Switches the whole workspace: docks and panes together. */
  switchTo(id: string): void {
    if (id === this._activeId() || !this._views().some((v) => v.id === id)) {
      return;
    }
    this.dock.switchView(id);
    this.panes.switchView(id);
    this._activeId.set(id);
  }

  /** `Ctrl+1`…`Ctrl+9`: the view at 0-based `index`; a missing one does nothing. */
  switchToIndex(index: number): void {
    const view = this._views()[index];
    if (view !== undefined) {
      this.switchTo(view.id);
    }
  }

  /** The "Switch view" command: the next view, wrapping around. */
  switchToNext(): void {
    const views = this._views();
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
    const view = this._views().find((v) => v.id === id);
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
    return this._views().some((v) => v.id !== exceptId && v.label.toLowerCase() === wanted);
  }

  // --- the list --------------------------------------------------------------

  /**
   * "Save current layout as a view…": the new view starts as a copy of the
   * active one -- the same docks, panes and tabs (documents are shared, not
   * copied) -- and becomes the active view.
   */
  saveCurrentAs(label: string): string {
    const id = `view-${Date.now().toString(36)}-${this._views().length}`;
    this.dock.copyActiveTo(id);
    this.panes.cloneActiveViewTo(id);
    this._views.update((views) => [...views, { id, label: label.trim(), builtin: false }]);
    this.persist();
    this.switchTo(id);
    return id;
  }

  rename(id: string, label: string): void {
    this._views.update((views) =>
      views.map((v) => (v.id === id && !v.builtin ? { ...v, label: label.trim() } : v)),
    );
    this.persist();
  }

  /**
   * Deletes a user view. A document that only this view held is closed
   * (asking about unsaved changes); one the user keeps open instead moves
   * to Notes -- a document held by no view cannot be open.
   */
  async remove(id: string): Promise<void> {
    const view = this._views().find((v) => v.id === id);
    if (view === undefined || view.builtin) {
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
    this._views.update((views) => views.filter((v) => v.id !== id));
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
      const user = this._views().filter((v) => !v.builtin);
      localStorage.setItem(KEY, JSON.stringify({ views: user }));
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
          return [NOTES, ...user.map((v) => ({ id: v.id, label: v.label, builtin: false }))];
        }
      }
    } catch {
      // A damaged list: only Notes.
    }
    return [NOTES];
  }
}
