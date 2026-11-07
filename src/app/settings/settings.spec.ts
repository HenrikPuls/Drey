import { Component, input, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { EditorService } from '../services/editor.service';
import { SettingsService } from '../services/settings.service';
import { Settings } from './settings';
import { SettingsCategoryRegistry } from './settings-registry.service';

@Component({
  selector: 'app-long-page',
  template: `
    <h2>Long page</h2>
    <div data-settings-section="one" style="height: 400px">One</div>
    <div data-settings-section="two" style="height: 400px">Two</div>
    <label>Sync interval</label>
  `,
})
class LongPage {
  readonly contrib = input<unknown>();
}

const fakeService = {
  draft: signal({}),
  openCategory: signal<string | null>(null),
  screenOpen: signal(true),
  editingText: signal(false),
  saving: signal(false),
  saveError: signal<string | null>(null),
  isDirty: signal(false),
  flush: () => Promise.resolve(true),
  openScreen: () => 1,
  closeScreen: vi.fn(),
};
const fakeEditor = { closeTab: vi.fn(() => Promise.resolve(true)) };

describe('Settings screen (E13-22)', () => {
  let fixture: ComponentFixture<Settings>;
  let root: HTMLElement;

  beforeEach(() => {
    // Opens on the plugin page: the core pages need the real service.
    fakeService.openCategory.set('long');
    fakeEditor.closeTab.mockClear();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsService, useValue: fakeService },
        { provide: EditorService, useValue: fakeEditor },
      ],
    });
    TestBed.inject(SettingsCategoryRegistry).registerPluginPage(
      {
        id: 'long',
        label: 'Long',
        hint: 'A long page',
        sections: [
          { id: 'one', label: 'Part one' },
          { id: 'two', label: 'Part two' },
        ],
        entries: [{ key: 'sync', label: 'Sync interval', description: 'Seconds', section: 'two' }],
        mount: () => () => undefined,
      },
      LongPage,
    );
    fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();
    root = fixture.nativeElement as HTMLElement;
  });

  const click = (el: Element | null): void => {
    (el as HTMLElement).click();
    fixture.detectChanges();
  };
  const entries = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.section-entry')];
  const labels = (): (string | undefined)[] => entries().map((e) => e.querySelector('.section-label')?.textContent?.trim());
  const category = (label: string): HTMLElement =>
    [...root.querySelectorAll<HTMLElement>('.category')].find((c) => c.textContent?.includes(label))!;

  it('lists sections under the selected category, expandable and collapsible', () => {
    expect(labels()).toEqual(['Part one', 'Part two']);
    // Counts only show while searching (board 7g).
    expect(entries().map((e) => e.querySelector('.count'))).toEqual([null, null]);
    const long = category('Long');
    expect(long.getAttribute('aria-expanded')).toBe('true');
    click(long);
    expect(entries()).toHaveLength(0);
    expect(category('Long').getAttribute('aria-expanded')).toBe('false');
    click(category('Long'));
    expect(entries()).toHaveLength(2);
  });

  it('highlights the section in view while the page scrolls (scroll-spy)', () => {
    const detail = root.querySelector<HTMLElement>('.detail')!;
    const anchors = [...detail.querySelectorAll<HTMLElement>('[data-settings-section]')];
    const tops = [0, 400];
    anchors.forEach((a, i) =>
      Object.defineProperty(a, 'getBoundingClientRect', {
        value: () => ({ top: tops[i] - detail.scrollTop }),
      }),
    );
    Object.defineProperty(detail, 'getBoundingClientRect', { value: () => ({ top: 0 }) });
    // At the very top no section is singled out; only the category is lit (board 7g).
    detail.scrollTop = 0;
    detail.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(root.querySelector('.section-entry.active')).toBeNull();
    expect(root.querySelector('.category.active')?.textContent).toContain('Long');
    detail.scrollTop = 10;
    detail.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    expect(root.querySelector('.section-entry.active')?.textContent?.trim()).toBe('Part one');
    expect(root.querySelector('.category.active')).toBeNull();
    detail.scrollTop = 390;
    detail.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
    const active = root.querySelector('.section-entry.active')!;
    expect(active.querySelector('.section-label')?.textContent?.trim()).toBe('Part two');
    expect(active.getAttribute('aria-current')).toBe('location');
  });

  it('filters the settings of all pages and opens the page of a hit', () => {
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'watch';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const results = [...root.querySelectorAll('.result')];
    expect(results.map((r) => r.querySelector('.result-label')?.textContent)).toContain(
      'Watch the vault for external changes',
    );
    search.value = 'sync interval';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    const hit = root.querySelector('.result')!;
    expect(hit.querySelector('.result-where')?.textContent?.trim()).toBe('Long › Part two ›');
    click(hit);
    expect(root.querySelector('.results')).toBeNull();
    expect(root.querySelector('.category.active')?.textContent).toContain('Long');
  });

  it('owner decision: the search field of board 7g carries its placeholder', () => {
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search.getAttribute('aria-label')).toBe('Search settings');
    expect(search.getAttribute('placeholder')).toBe('Search settings');
  });

  it('draws no footer, no Close button and no X (board 7g); Escape closes the tab', async () => {
    expect(root.querySelector('footer, .actions-bar, .close, .backdrop')).toBeNull();
    expect(root.textContent).not.toContain('Changes are saved automatically');
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await fixture.whenStable();
    expect(fakeEditor.closeTab).toHaveBeenCalledTimes(1);
    // Escape meant for something else (focus in another element) does not close it.
    const other = document.body.appendChild(document.createElement('input'));
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    other.remove();
    await fixture.whenStable();
    expect(fakeEditor.closeTab).toHaveBeenCalledTimes(1);
    expect(fakeEditor.closeTab).toHaveBeenCalledWith('settings://');
  });

  it('ends its session when the tab goes', async () => {
    fixture.destroy();
    await Promise.resolve();
    await Promise.resolve();
    expect(fakeService.closeScreen).toHaveBeenCalledWith(1);
  });

  it('is operable by keyboard: every entry is a native button', () => {
    for (const el of [...entries(), ...root.querySelectorAll('.category')]) {
      expect(el.tagName).toBe('BUTTON');
      expect((el as HTMLButtonElement).tabIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('clears the search first on Escape', () => {
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = 'vault';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(search.value).toBe('');
    expect(root.querySelector('.results')).toBeNull();
  });

  const typeQuery = (text: string): void => {
    const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = text;
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  it('names the query when nothing matches and offers to clear the search', () => {
    typeQuery('zzzqq');
    expect(root.querySelector('.no-match')?.textContent).toContain('No setting matches "zzzqq"');
    click(root.querySelector('.no-match button'));
    expect(root.querySelector('.no-match')).toBeNull();
    expect(root.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('');
  });

  it('shows the hits of a page beside its label while searching, and dims the rest', () => {
    expect(category('Long').querySelector('.count')).toBeNull();
    typeQuery('sync interval');
    expect(category('Long').querySelector('.count')?.textContent?.trim()).toBe('1');
    expect(category('Long').classList.contains('dim')).toBe(false);
    expect(root.querySelector('.found')?.textContent?.trim()).toBe('1 setting');
    expect([...root.querySelectorAll('.category.dim')].length).toBeGreaterThan(0);
  });

  it('draws "All devices" as the chosen tab until another is picked, with its note', () => {
    const tabs = [...root.querySelectorAll<HTMLElement>('.scope-tab')];
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.scope-note')?.textContent).toBe('Synced to every device you pair');
    click(tabs[1]);
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(root.querySelector('.scope-note')?.textContent).toBe('Overrides for this computer only');
    click(tabs[0]);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
  });

  it('offers the three scope tabs, filters the hits by scope and toggles back', () => {
    const tabs = [...root.querySelectorAll<HTMLElement>('.scope-tab')];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['All devices', 'This device', 'This vault']);
    expect(tabs.every((t) => t.getAttribute('role') === 'tab')).toBe(true);
    typeQuery('watch');
    click(tabs[1]);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(root.querySelector('.no-match')).not.toBeNull();
    click(tabs[2]);
    expect(root.querySelector('.result-label')?.textContent).toBe('Watch the vault for external changes');
    click(tabs[2]);
    expect(tabs[2].getAttribute('aria-selected')).toBe('false');
  });

  it('lists every setting of a scope when a tab is chosen without a query', () => {
    click(root.querySelectorAll('.scope-tab')[2]);
    const labelsShown = [...root.querySelectorAll('.result-label')].map((r) => r.textContent);
    expect(labelsShown).toContain('Watch the vault for external changes');
    expect(labelsShown).not.toContain('Theme');
  });
});
