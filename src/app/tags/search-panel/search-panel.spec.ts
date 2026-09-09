import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SearchPanel } from './search-panel';
import { TagSearchService } from '../tag-search.service';
import { EditorService } from '../../services/editor.service';
import { DreyApi, TagSearchHit, TagSearchQuery } from '../../../../shared/ipc-api';

describe('SearchPanel', () => {
  let fixture: ComponentFixture<SearchPanel>;
  let search: TagSearchService;
  let editor: EditorService;
  let queries: TagSearchQuery[];

  const HITS: TagSearchHit[] = [
    {
      path: 'daily/2026/09/2026-09-06.md',
      heading: '08:00',
      line: 4,
      snippet: 'Kielboot besichtigt',
      text: 'Kielboot besichtigt, Preis noch offen. #sailing',
    },
  ];

  beforeEach(async () => {
    queries = [];
    window.dreyApi = {
      listTags: () => Promise.resolve([{ tag: 'sailing', count: 3 }]),
      readVaultFile: (p: string) =>
        Promise.resolve({ content: `# ${p}\n\nx\ny\nz\n`, modifiedMs: 1 }),
      searchTags: (q: TagSearchQuery) => {
        queries.push(q);
        return Promise.resolve(HITS);
      },
    } as unknown as DreyApi;

    await TestBed.configureTestingModule({ imports: [SearchPanel] }).compileComponents();
    fixture = TestBed.createComponent(SearchPanel);
    search = TestBed.inject(TagSearchService);
    editor = TestBed.inject(EditorService);
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    search.clear();
  });

  it('runs a search over the collected tags + text and lists the hits', async () => {
    search.addTag('#Sailing'); // normalised to `sailing`
    search.setText('kiel');
    await search.run();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.head')!.click(); // expand
    fixture.detectChanges();

    expect(queries).toEqual([{ tags: ['sailing'], text: 'kiel' }]);
    expect(el.querySelectorAll('.hit').length).toBe(1);
    expect(el.querySelector('.hit-heading')?.textContent?.trim()).toBe('08:00');
  });

  it('a hit opens the file at its line', async () => {
    search.addTag('sailing');
    await search.run();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.head')!.click();
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.hit')!.click();
    await fixture.whenStable();

    expect(editor.openPath()).toBe('daily/2026/09/2026-09-06.md');
    expect(editor.revealRequest()).toMatchObject({
      path: 'daily/2026/09/2026-09-06.md',
      line: 4,
    });
  });

  it('does not search an empty query', async () => {
    await search.run();
    expect(queries).toEqual([]);
    expect(search.ran()).toBe(false);
  });

  it('exports the hits into an unsaved search-results.md tab', async () => {
    search.addTag('sailing');
    await search.run();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.head')!.click();
    fixture.detectChanges();

    const exportBtn = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.ghost'),
    ).find((b) => b.textContent?.trim() === 'Export')!;
    exportBtn.click();
    await fixture.whenStable();

    expect(editor.openPath()).toBe('search-results.md');
    expect(editor.activeIsDraft()).toBe(true);
    expect(editor.bufferContent()).toContain('## daily/2026/09/2026-09-06.md:4');
    expect(editor.bufferContent()).toContain('Kielboot besichtigt, Preis noch offen. #sailing');
  });

  it('still exposes the parked summarise() on the service', async () => {
    (window.dreyApi as unknown as { summariseSearchResults: unknown }).summariseSearchResults =
      () => Promise.resolve('Two boats seen, price still open.');
    search.addTag('sailing');
    await search.run();
    await search.summarise();
    expect(search.summary()).toBe('Two boats seen, price still open.');
  });
});
