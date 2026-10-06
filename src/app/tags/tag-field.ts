import type { TagEntry } from '../../../shared/plugin-api/search-types';
import type { TagStyleInfo } from '../../../shared/tag-style';
import { tagChipColors } from '../../../shared/tag-style';
import { splitQuery, tagQueryAtCaret } from './tag-query';

/**
 * What a tag field needs from the app: the live vocabulary and the color
 * resolver. `TagVocabularyService` implements it; tests pass fakes.
 */
export interface TagFieldVocabulary {
  entries(): readonly TagEntry[];
  styleFor(tag: string): TagStyleInfo;
}

export interface TagFieldOptions {
  values?: readonly string[];
  onChange(values: string[]): void;
  placeholder?: string;
  ariaLabel?: string;
  completions?: boolean;
  /**
   * Free-text mode (milestone 43): the one input holds a free-text query,
   * and a `#name` word typed into it lifts out into a chip (on the space
   * after it, on Enter, on blur, or when picked from the dropdown). The
   * Search and Tasks panels use it so a tag and a text filter share one
   * field.
   */
  freeText?: {
    value?: string;
    /** Fires with the text that remains after tag words were lifted out. */
    onInput(text: string): void;
    /** Enter with no dropdown open. */
    onSubmit?(): void;
  };
}

const MAX_OPTIONS = 12;

/**
 * The shared tag chip field (milestone 33): colored chips plus a completion
 * dropdown fed by the tag vocabulary. ONE implementation for every surface
 * that takes tags — the base entry drawer mounts it directly, plugins get
 * it through `api.ui.createTagField` — replacing the three hand-rolled
 * chip rows (drawer, Search panel, Tasks filter) that had no completion at
 * all.
 *
 * Plain DOM by design: it must mount identically in Angular templates and
 * in plugin widget hosts. Styling lives in `src/styles.css` under
 * `.tag-field*` (global sheet, so plugin documents get it for free).
 *
 * Keys: Enter/comma/Tab commit the input (picking the highlighted
 * suggestion when the dropdown is open), Backspace on an empty input pops
 * the last chip, Esc closes the dropdown, blur commits a partial input.
 * Values are normalized like everywhere else: trimmed, `#` stripped,
 * lower-cased, de-duplicated.
 */
export class TagField {
  readonly element: HTMLElement;

  private readonly chipsEl: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly menu: HTMLElement;

  private values: string[] = [];
  private options: TagEntry[] = [];
  private activeIndex = -1;
  private menuOpen = false;

  constructor(
    private readonly vocab: TagFieldVocabulary,
    private readonly opts: TagFieldOptions,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'tag-field';

    this.chipsEl = document.createElement('div');
    this.chipsEl.className = 'tag-field-chips';

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'tag-field-input';
    this.input.placeholder = opts.placeholder ?? (opts.freeText ? '' : '+ tag');
    if (opts.freeText) {
      this.element.classList.add('tag-field--free');
      this.input.value = opts.freeText.value ?? '';
    }
    this.input.setAttribute('aria-label', opts.ariaLabel ?? 'Tags');
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;

    this.menu = document.createElement('ul');
    this.menu.className = 'tag-field-menu';
    this.menu.setAttribute('role', 'listbox');
    this.menu.hidden = true;

    this.chipsEl.appendChild(this.input);
    this.element.appendChild(this.chipsEl);
    this.element.appendChild(this.menu);

    this.input.addEventListener('input', () => {
      if (this.opts.freeText) {
        this.liftTags(this.input.selectionStart ?? this.input.value.length);
      }
      this.refreshMenu();
    });
    this.input.addEventListener('keydown', (e) => this.onKeydown(e));
    this.input.addEventListener('blur', () => {
      // Commit a partial input on focus loss, like every chip field before.
      if (this.opts.freeText) {
        this.liftTags(null);
      } else {
        this.commitInput();
      }
      window.setTimeout(() => this.closeMenu(), 120);
    });
    this.input.addEventListener('focus', () => this.refreshMenu());

    this.setValues(opts.values ?? []);
  }

  focus(): void {
    this.input.focus();
  }

  setValues(values: readonly string[]): void {
    this.values = [...values];
    this.renderChips();
  }

  /** Free-text mode: replaces the input text without firing `onInput`. */
  setText(text: string): void {
    if (this.input.value !== text) {
      this.input.value = text;
    }
  }

  /**
   * Free-text mode: turns every complete `#tag` word in the input into a
   * chip. `caret` protects the word still being typed (see `splitQuery`).
   */
  private liftTags(caret: number | null): void {
    const free = this.opts.freeText;
    if (!free) {
      return;
    }
    const before = this.input.value;
    const { tags, text } = splitQuery(before, caret);
    const added = tags.filter((tag) => !this.values.includes(tag));
    if (text !== before) {
      const shift = before.length - text.length;
      const at = Math.max(0, (this.input.selectionStart ?? before.length) - shift);
      this.input.value = text;
      this.input.setSelectionRange(at, at);
    }
    if (added.length > 0) {
      this.values = [...this.values, ...added];
      this.renderChips();
      this.opts.onChange([...this.values]);
    }
    // A blur that lifted nothing must stay silent: the owner re-renders on
    // `onInput`, and rebuilding a result list between the mousedown that
    // blurred the field and its click would swallow that click.
    if (caret !== null || text !== before) {
      free.onInput(this.input.value);
    }
  }

  dispose(): void {
    this.element.remove();
  }

  private normalize(raw: string): string {
    return raw.trim().toLowerCase().replace(/^#/, '');
  }

  private commitInput(): void {
    const value = this.normalize(this.input.value);
    this.input.value = '';
    this.closeMenu();
    if (value === '' || this.values.includes(value)) {
      return;
    }
    this.values = [...this.values, value];
    this.renderChips();
    this.opts.onChange([...this.values]);
  }

  private popChip(): void {
    if (this.values.length === 0) {
      return;
    }
    this.values = this.values.slice(0, -1);
    this.renderChips();
    this.opts.onChange([...this.values]);
  }

  private removeChip(value: string): void {
    this.values = this.values.filter((v) => v !== value);
    this.renderChips();
    this.opts.onChange([...this.values]);
  }

  private renderChips(): void {
    for (const child of [...this.chipsEl.children]) {
      if (child !== this.input) {
        child.remove();
      }
    }
    for (const value of this.values) {
      const { fg, bg } = tagChipColors(this.vocab.styleFor(value).color);
      const chip = document.createElement('span');
      chip.className = 'tag-field-chip';
      chip.style.color = fg;
      chip.style.backgroundColor = bg;
      chip.appendChild(document.createTextNode(`#${value}`));
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'tag-field-x';
      x.textContent = '×';
      x.title = `Remove #${value}`;
      x.setAttribute('aria-label', `Remove #${value}`);
      x.addEventListener('mousedown', (e) => e.preventDefault()); // keep input focus
      x.addEventListener('click', () => this.removeChip(value));
      chip.appendChild(x);
      this.chipsEl.insertBefore(chip, this.input);
    }
  }

  private refreshMenu(): void {
    if (this.opts.completions === false) {
      return;
    }
    const query = this.opts.freeText
      ? (tagQueryAtCaret(this.input.value, this.input.selectionStart ?? this.input.value.length) ??
        '')
      : this.normalize(this.input.value);
    if (query === '') {
      this.closeMenu();
      return;
    }
    this.options = this.vocab
      .entries()
      .filter((e) => !this.values.includes(e.tag) && e.tag.startsWith(query))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, MAX_OPTIONS);
    if (this.options.length === 0) {
      this.closeMenu();
      return;
    }
    this.activeIndex = 0;
    this.menuOpen = true;
    this.menu.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.renderMenu();
  }

  private renderMenu(): void {
    for (const child of [...this.menu.children]) {
      child.remove();
    }
    this.options.forEach((entry, i) => {
      const { fg, bg } = tagChipColors(this.vocab.styleFor(entry.tag).color);
      const li = document.createElement('li');
      li.className = 'tag-field-option';
      if (i === this.activeIndex) {
        li.classList.add('active');
      }
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === this.activeIndex ? 'true' : 'false');
      const tag = document.createElement('span');
      tag.className = 'tag-field-option-tag';
      tag.textContent = `#${entry.tag}`;
      tag.style.color = fg;
      tag.style.backgroundColor = bg;
      const count = document.createElement('span');
      count.className = 'tag-field-option-count';
      count.textContent = `${entry.count}×`;
      li.appendChild(tag);
      li.appendChild(count);
      // mousedown-preventDefault keeps the input focused so blur-commit
      // doesn't fire before the click.
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => this.pickOption(entry.tag));
      this.menu.appendChild(li);
    });
  }

  private pickOption(tag: string): void {
    if (this.opts.freeText) {
      // Cut the `#partial` under the caret; the rest of the query stays.
      const caret = this.input.selectionStart ?? this.input.value.length;
      const head = this.input.value.slice(0, caret).replace(/#[^\s#]*$/u, '');
      this.input.value = head + this.input.value.slice(caret).replace(/^ /, '');
      this.input.setSelectionRange(head.length, head.length);
      this.opts.freeText.onInput(this.input.value);
    } else {
      this.input.value = '';
    }
    this.closeMenu();
    if (tag === '' || this.values.includes(tag)) {
      return;
    }
    this.values = [...this.values, tag];
    this.renderChips();
    this.opts.onChange([...this.values]);
    this.input.focus();
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.activeIndex = -1;
    for (const child of [...this.menu.children]) {
      child.remove();
    }
    this.menu.hidden = true;
    this.input.removeAttribute('aria-expanded');
  }

  private onKeydown(e: KeyboardEvent): void {
    const atStart = this.input.selectionStart === 0 && this.input.selectionEnd === 0;
    if (
      e.key === 'Backspace' &&
      (this.input.value === '' || (this.opts.freeText !== undefined && atStart))
    ) {
      this.popChip();
      return;
    }
    if (this.menuOpen && e.key === 'ArrowDown') {
      e.preventDefault();
      this.activeIndex = Math.min(this.activeIndex + 1, this.options.length - 1);
      this.renderMenu();
      return;
    }
    if (this.menuOpen && e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeIndex = Math.max(this.activeIndex - 1, 0);
      this.renderMenu();
      return;
    }
    if (e.key === 'Escape' && this.menuOpen) {
      e.stopPropagation();
      this.closeMenu();
      return;
    }
    if (this.opts.freeText) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.menuOpen) {
          this.pickOption(this.options[this.activeIndex]?.tag ?? '');
          return;
        }
        this.liftTags(null);
        this.opts.freeText.onSubmit?.();
      }
      return;
    }
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (this.menuOpen && e.key !== 'Tab') {
        e.preventDefault();
        this.pickOption(this.options[this.activeIndex]?.tag ?? this.normalize(this.input.value));
        return;
      }
      if (e.key === 'Tab') {
        return; // plain Tab navigates; blur commits
      }
      e.preventDefault();
      this.commitInput();
    }
  }
}
