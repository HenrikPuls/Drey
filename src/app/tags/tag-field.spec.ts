import { TagField, type TagFieldVocabulary } from './tag-field';

const VOCAB: TagFieldVocabulary = {
  entries: () => [
    { tag: 'sailing', count: 9 },
    { tag: 'sales', count: 2 },
    { tag: 'projekt/frontend', count: 5 },
  ],
  styleFor: (tag) => ({ color: tag === 'sailing' ? '#c96442' : '#4f9a90', origin: 'auto' }),
};

function field(values: string[] = [], opts: Partial<ConstructorParameters<typeof TagField>[1]> = {}) {
  const changes: string[][] = [];
  const f = new TagField(VOCAB, {
    values,
    onChange: (next) => changes.push([...next]),
    ...opts,
  });
  document.body.appendChild(f.element);
  return { f, changes };
}

function input(f: TagField): HTMLInputElement {
  return f.element.querySelector<HTMLInputElement>('.tag-field-input')!;
}

function chips(f: TagField): HTMLElement[] {
  return [...f.element.querySelectorAll<HTMLElement>('.tag-field-chip')];
}

function options(f: TagField): HTMLElement[] {
  return [...f.element.querySelectorAll<HTMLElement>('.tag-field-option')];
}

/** keydown + (for text keys) the input event the listener actually reads. */
function type(f: TagField, key: string, init: KeyboardEventInit = {}): void {
  const el = input(f);
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

afterEach(() => document.body.innerHTML = '');

describe('TagField', () => {
  it('renders initial chips, colored from the vocabulary', () => {
    const { f } = field(['sailing']);
    const chip = chips(f)[0];
    expect(chip.textContent).toContain('#sailing');
    // The browser normalizes hex to rgb().
    expect(chip.style.color).toContain('rgb(201, 100, 66)');
    expect(chip.style.backgroundColor).not.toBe('');
  });

  it('commits on Enter: normalized, de-duplicated, reported once', () => {
    const { f, changes } = field(['sailing']);
    input(f).value = ' Kauf ';
    type(f, 'Enter');
    expect(chips(f).map((c) => c.textContent)).toEqual(['#sailing×', '#kauf×']);
    expect(changes).toEqual([['sailing', 'kauf']]);
    expect(input(f).value).toBe('');
  });

  it('strips a leading # and lower-cases', () => {
    const { f, changes } = field();
    input(f).value = '#Projekt/Frontend';
    type(f, 'Enter');
    expect(changes).toEqual([['projekt/frontend']]);
  });

  it('silently drops an empty or duplicate commit', () => {
    const { f, changes } = field(['kauf']);
    input(f).value = '#KAUF';
    type(f, 'Enter');
    input(f).value = '   ';
    type(f, 'Enter');
    expect(changes).toEqual([]);
    expect(chips(f)).toHaveLength(1);
  });

  it('Backspace on an empty input pops the last chip', () => {
    const { f, changes } = field(['a', 'b']);
    type(f, 'Backspace');
    expect(changes).toEqual([['a']]);
  });

  it('opens a filtered dropdown while typing and picks with Enter', () => {
    const { f, changes } = field();
    input(f).value = 'sa';
    input(f).dispatchEvent(new Event('input', { bubbles: true }));
    const opts = options(f);
    expect(opts).toHaveLength(2); // sailing (9) before sales (2)
    expect(opts[0].textContent).toContain('#sailing');
    type(f, 'Enter');
    expect(changes).toEqual([['sailing']]);
  });

  it('navigates the dropdown with the arrow keys', () => {
    const { f, changes } = field();
    input(f).value = 'sa';
    input(f).dispatchEvent(new Event('input', { bubbles: true }));
    type(f, 'ArrowDown');
    type(f, 'Enter');
    expect(changes).toEqual([['sales']]);
  });

  it('excludes values already chosen from the dropdown', () => {
    const { f } = field(['sailing']);
    input(f).value = 'sa';
    input(f).dispatchEvent(new Event('input', { bubbles: true }));
    expect(options(f).map((o) => o.textContent)).toEqual(['#sales2×']);
  });

  it('Escape closes the dropdown without committing', () => {
    const { f, changes } = field();
    input(f).value = 'sa';
    input(f).dispatchEvent(new Event('input', { bubbles: true }));
    type(f, 'Escape');
    expect(options(f)).toHaveLength(0);
    expect(input(f).value).toBe('sa');
    expect(changes).toEqual([]);
  });

  it('setValues repaints without firing onChange', () => {
    const { f, changes } = field(['a']);
    f.setValues(['x', 'y']);
    expect(chips(f).map((c) => c.textContent)).toEqual(['#x×', '#y×']);
    expect(changes).toEqual([]);
  });

  it('completions: false suppresses the dropdown but keeps chip editing', () => {
    const { f, changes } = field([], { completions: false });
    input(f).value = 'sa';
    input(f).dispatchEvent(new Event('input', { bubbles: true }));
    expect(options(f)).toHaveLength(0);
    type(f, 'Enter');
    expect(changes).toEqual([['sa']]);
  });

  it('removing a chip reports the remaining values', () => {
    const { f, changes } = field(['a', 'b']);
    const x = chips(f)[0].querySelector<HTMLButtonElement>('.tag-field-x')!;
    x.click();
    expect(changes).toEqual([['b']]);
  });
});
