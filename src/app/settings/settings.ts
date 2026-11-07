import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  type OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import type { MessageKey } from '../../../shared/i18n';
import { I18nPipe } from '../i18n';
import { Icon } from '../icons/icon';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { SETTINGS_DOC_KEY } from './settings-doc';
import { SettingsCategoryRegistry } from './settings-registry.service';
import {
  SETTINGS_SCOPES,
  activeSection,
  filterHitsByScope,
  type SettingsScope,
  searchSettings,
  type SettingsSearchEntry,
  type SettingsSearchHit,
} from './settings-model';

/** Distance below the scrollport's top at which a section counts as reached. */
const SPY_OFFSET = 24;

/**
 * The Settings screen: master-detail per CLAUDE.md's "UI/UX Design" -- a
 * category list on the left, the detail pane on the right. Shown as an
 * editor tab (board 7g; `SettingsTabService` mounts it into the pane's body).
 * The category list is a data-driven
 * registry (`SettingsCategory[]`), rendered through `NgComponentOutlet`, so
 * a new category is one array entry -- no `@switch` to extend.
 *
 * Every change is applied as it is made (ADR-0010 later change): a pane
 * writes `SettingsService.draft`, which saves itself. This component tells
 * the service while a text field has the focus -- the save then waits for
 * the field to be left or Enter -- and flushes before the tab closes.
 * No footer, no Save, no Discard, no "unsaved changes" prompt; Escape
 * closes the tab like any tab's close.
 */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [I18nPipe, Icon, NgComponentOutlet],
  templateUrl: './settings.html',
  styleUrl: './settings.css',
  host: {
    tabindex: '-1',
    style: 'display: flex; flex: 1; min-width: 0; min-height: 0; outline: none',
    '(document:keydown.escape)': 'onEscape($event)',
    '(window:blur)': 'flush()',
  },
})
export class Settings implements OnDestroy {
  protected readonly settings = inject(SettingsService);
  private readonly editor = inject(EditorService);
  private readonly hostEl = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /** The session this tab started (`SettingsService.openScreen`). */
  private readonly session = this.settings.openScreen(this.settings.openCategory() ?? undefined);
  private readonly registry = inject(SettingsCategoryRegistry);

  /** Core categories + plugin-contributed pages, from the registry. */
  protected readonly categories = this.registry.categories;

  /** A caller-named category (Help -> About) wins; falls back to the first. */
  private readonly presetCategory = this.settings.openCategory();

  constructor() {
    // Focus the tab itself (no ring), so Escape and the keys reach it without a field being picked.
    afterNextRender(() => this.hostEl.focus({ preventScroll: true }), { injector: this.injector });
    // Help -> About while the tab is already open names a page after the fact.
    effect(() => {
      const wanted = this.settings.openCategory();
      if (wanted !== null && this.categories().some((category) => category.id === wanted)) {
        untracked(() => {
          if (wanted !== this.selected()) {
            this.selectCategory(wanted);
          }
          this.settings.openCategory.set(null);
        });
      }
    });
  }

  protected readonly selected = signal<string>(
    this.presetCategory !== null &&
      this.categories().some((category) => category.id === this.presetCategory)
      ? this.presetCategory
      : (this.categories()[0]?.id ?? ''),
  );

  protected readonly selectedComponent = computed(
    () =>
      (this.registry.categoryFor(this.selected()) ?? this.categories()[0]).component,
  );

  /** `{ contrib }` for a plugin page, `undefined` for a core one. */
  protected readonly selectedInputs = computed(() => this.registry.inputsFor(this.selected()));

  private readonly injector = inject(Injector);
  private readonly detail = viewChild<ElementRef<HTMLElement>>('detail');

  protected readonly query = signal('');
  protected readonly scopes = SETTINGS_SCOPES;
  /** The scope tab chosen (board 7g); `null` = none, everything shows. */
  protected readonly scope = signal<SettingsScope | null>(null);
  protected readonly hits = computed<readonly SettingsSearchHit[]>(() =>
    this.query().trim() === ''
      ? this.scope() === null
        ? []
        : this.scopeBrowse()
      : filterHitsByScope(searchSettings(this.registry.searchSources(), this.query()), this.scope()),
  );
  /** Every setting of the chosen scope, in page order (no query typed). */
  private scopeBrowse(): SettingsSearchHit[] {
    return this.registry.searchSources().flatMap((source) =>
      (source.entries ?? [])
        .filter((entry) => entry.scope === this.scope())
        .map((entry) => ({
          categoryId: source.id,
          categoryLabel: source.label,
          sectionLabel: source.sections?.find((s) => s.id === entry.section)?.label ?? null,
          entry,
        })),
    );
  }
  protected readonly searching = computed(() => this.query().trim() !== '' || this.scope() !== null);

  /** How many of the current hits a category holds (the tree shows it while searching). */
  protected categoryHits(id: string): number {
    return this.hits().filter((hit) => hit.categoryId === id).length;
  }

  protected sectionHits(categoryId: string, sectionId: string): number {
    return this.hits().filter((hit) => hit.categoryId === categoryId && hit.entry.section === sectionId).length;
  }

  /** The tab drawn as chosen: "All devices" until another is picked (board 7g). */
  protected readonly shownScope = computed<SettingsScope>(() => this.scope() ?? 'all-devices');

  protected readonly scopeNoteKey = computed<MessageKey>(() => {
    const shown = this.shownScope();
    return shown === 'device'
      ? 'settings.scope.note_device'
      : shown === 'vault'
        ? 'settings.scope.note_vault'
        : 'settings.scope.note_all_devices';
  });

  /**
   * "All devices" is the page as it is (no filter); "This device" and "This
   * vault" list the settings stored for that scope, a second click leaves
   * the list again.
   */
  protected pickScope(scope: SettingsScope): void {
    this.scope.update((current) => (scope === 'all-devices' || current === scope ? null : scope));
  }

  protected clearSearch(): void {
    this.query.set('');
    this.scope.set(null);
  }

  /** The section entry highlighted for the page's scroll position (E13-22). */
  protected readonly currentSection = signal<string | null>(null);

  /** A category's own expand/collapse choice; unset follows the selection. */
  private readonly expandChoice = signal<Readonly<Record<string, boolean>>>({});

  protected isExpanded(id: string): boolean {
    return this.expandChoice()[id] ?? this.selected() === id;
  }

  protected toggleExpanded(id: string): void {
    const open = this.isExpanded(id);
    this.expandChoice.update((choice) => ({ ...choice, [id]: !open }));
  }

  protected selectCategory(id: string): void {
    const again = this.selected() === id && !this.searching();
    this.clearSearch();
    if (again) {
      // A second click on the open category folds or unfolds its sections (board 7g).
      this.toggleExpanded(id);
    } else {
      this.expandChoice.update(({ [id]: _unset, ...rest }) => rest);
    }
    this.currentSection.set(null);
    this.selected.set(id);
    this.afterRender(() => {
      this.detail()?.nativeElement.scrollTo({ top: 0 });
      this.updateSpy();
    });
  }

  /** A click on a section entry: its page, scrolled to the section. */
  protected openSection(categoryId: string, sectionId: string): void {
    this.clearSearch();
    this.selected.set(categoryId);
    this.afterRender(() => this.scrollToSection(sectionId));
  }

  /** A search hit: its page, scrolled to the setting. */
  protected openHit(hit: SettingsSearchHit): void {
    this.clearSearch();
    this.selected.set(hit.categoryId);
    this.afterRender(() => this.scrollToEntry(hit.entry));
  }

  protected onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.searching()) {
      this.clearSearch();
      event.stopPropagation();
    }
  }

  protected onScroll(): void {
    this.updateSpy();
  }

  private afterRender(work: () => void): void {
    afterNextRender(work, { injector: this.injector });
  }

  private anchors(): { id: string; top: number }[] {
    const root = this.detail()?.nativeElement;
    if (!root) {
      return [];
    }
    const base = root.getBoundingClientRect().top - root.scrollTop;
    return [...root.querySelectorAll<HTMLElement>('[data-settings-section]')].map((el) => ({
      id: el.dataset['settingsSection'] ?? '',
      top: el.getBoundingClientRect().top - base,
    }));
  }

  private updateSpy(): void {
    const root = this.detail()?.nativeElement;
    if (!root || this.searching()) {
      return;
    }
    if (root.scrollTop === 0) {
      // At the top of a page no section is singled out (board 7g: only the category is lit).
      this.currentSection.set(null);
      return;
    }
    this.currentSection.set(activeSection(this.anchors(), root.scrollTop, SPY_OFFSET));
  }

  private scrollToSection(sectionId: string): void {
    const root = this.detail()?.nativeElement;
    const anchor = this.anchors().find((a) => a.id === sectionId);
    if (root && anchor) {
      root.scrollTo({ top: Math.max(0, anchor.top - SPY_OFFSET / 2), behavior: 'smooth' });
      this.currentSection.set(sectionId);
    }
  }

  private scrollToEntry(entry: SettingsSearchEntry): void {
    const root = this.detail()?.nativeElement;
    if (!root) {
      return;
    }
    let target: HTMLElement | null =
      entry.key === ''
        ? null
        : root.querySelector<HTMLElement>(`[data-setting-key="${CSS.escape(entry.key)}"]`);
    if (!target && entry.key !== '') {
      target =
        [...root.querySelectorAll<HTMLElement>('label, h3, h4, .switch-label, .field-label')].find(
          (el) => el.textContent?.trim().startsWith(entry.label),
        ) ?? null;
    }
    if (target) {
      const found = target;
      found.scrollIntoView({ block: 'center', behavior: 'smooth' });
      found.classList.add('setting-found');
      setTimeout(() => found.classList.remove('setting-found'), 1600);
    } else if (entry.section) {
      this.scrollToSection(entry.section);
    } else {
      root.scrollTo({ top: 0 });
    }
  }

  /** A text field took the focus: hold the automatic save until it is left. */
  protected onFocusIn(event: FocusEvent): void {
    if (isTextEntry(event.target)) {
      this.settings.editingText.set(true);
    }
  }

  protected onFocusOut(event: FocusEvent): void {
    if (isTextEntry(event.target)) {
      this.settings.editingText.set(false);
      this.flush();
    }
  }

  /** Enter in a one-line field commits it (a textarea keeps Enter for the line break). */
  protected onEnter(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      // After the field's own `change` handler, which Enter also triggers.
      setTimeout(() => this.flush());
    }
  }

  protected flush(): void {
    void this.settings.flush();
  }

  /**
   * Saves what is pending, then closes the tab. A failed save keeps the tab
   * open with the error under the page, whose button then closes without
   * saving (`closeWithoutSaving`). Escape first leaves a search.
   */
  protected async requestClose(): Promise<void> {
    if (this.searching()) {
      this.clearSearch();
      return;
    }
    if (await this.settings.flush()) {
      void this.editor.closeTab(SETTINGS_DOC_KEY);
    }
  }

  /**
   * Escape closes the tab when it was meant for it: focus inside the tab, or on nothing (a button
   * that went away leaves it on the body). Focus in another pane, the palette or a dialog is theirs.
   */
  protected onEscape(event: Event): void {
    const target = event.target;
    if (target === document.body || (target instanceof Node && this.hostEl.contains(target))) {
      void this.requestClose();
    }
  }

  protected closeWithoutSaving(): void {
    this.settings.closeScreen(this.session);
    void this.editor.closeTab(SETTINGS_DOC_KEY);
  }

  /** The tab went (closed, or another tab shown): save what is pending, end the session. */
  ngOnDestroy(): void {
    void this.settings.flush().finally(() => this.settings.closeScreen(this.session));
  }
}

/** A field whose value is typed -- not a checkbox, radio, colour or file input. */
function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) {
    return true;
  }
  return (
    target instanceof HTMLInputElement &&
    ['text', 'number', 'password', 'url', 'search', 'email', ''].includes(target.type)
  );
}
