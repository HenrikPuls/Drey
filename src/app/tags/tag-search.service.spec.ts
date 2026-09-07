import { TestBed } from '@angular/core/testing';
import { TagSearchService } from './tag-search.service';
import { DreyApi, TagSearchQuery } from '../../../shared/ipc-api';

describe('TagSearchService', () => {
  let service: TagSearchService;
  let queries: TagSearchQuery[];

  beforeEach(() => {
    queries = [];
    window.dreyApi = {
      searchTags: (q: TagSearchQuery) => {
        queries.push(q);
        return Promise.resolve([]);
      },
    } as unknown as DreyApi;
    service = TestBed.inject(TagSearchService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('openPanel expands the panel and bumps the focus request', () => {
    const before = service.focusRequest();
    service.openPanel();
    expect(service.panelOpen()).toBe(true);
    expect(service.focusRequest()).toBe(before + 1);
  });

  it('togglePanel flips open/closed and only refocuses when opening', () => {
    service.togglePanel();
    expect(service.panelOpen()).toBe(true);
    const afterOpen = service.focusRequest();
    service.togglePanel();
    expect(service.panelOpen()).toBe(false);
    expect(service.focusRequest()).toBe(afterOpen); // no bump on close
  });

  it('searchTag replaces the whole query with the one tag, opens and runs', async () => {
    service.addTag('old');
    service.setText('stale text');

    service.searchTag('#Sailing');
    await Promise.resolve();

    expect(service.queryTags()).toEqual(['sailing']);
    expect(service.queryText()).toBe('');
    expect(service.panelOpen()).toBe(true);
    expect(queries).toEqual([{ tags: ['sailing'], text: '' }]);
  });
});
