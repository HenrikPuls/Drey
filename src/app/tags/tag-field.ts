import type { TagEntry } from '../../../shared/plugin-api/search-types';
import type { TagStyleInfo } from '../../../shared/tag-style';
import { tagChipColors } from '../../../shared/tag-style';

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
    this.input.placeholder = opts.placeholder ?? '+ tag';
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

    this.input.addEventListener('input', () => this.refreshMenu());
    this.input.addEventListener('keydown', (e) => this.onKeydown(e));
    this.input.addEventListener('blur', () => {
      // Commit a partial input on focus loss, like every chip field before.
      this.commitInput();
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
    const query = this.normalize(this.input.value);
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
    this.input.value = '';
    this.closeMenu();
    if (this.values.includes(tag)) {
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
    if (e.key === 'Backspace' && this.input.value === '') {
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
