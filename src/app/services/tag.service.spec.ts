import { TestBed } from '@angular/core/testing';
import { TagService } from './tag.service';
import { DreyApi, TagEntry } from '../../../shared/ipc-api';

const SAILING: TagEntry = {
  tag: 'sailing',
  aliases: ['boot'],
  art: 'thema',
  description: 'Kaufprozess',
  hasMaster: true,
  masterPath: 'sailing/_index.md',
};

describe('TagService', () => {
  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('stays empty when window.dreyApi is unavailable', async () => {
    const service = TestBed.inject(TagService);
    await Promise.resolve();
    expect(service.tags()).toEqual([]);
  });

  it('loads the tag list on construction and again on refresh', async () => {
    let list: TagEntry[] = [SAILING];
    const fakeApi: Partial<DreyApi> = {
      listTags: () => Promise.resolve(list),
    };
    window.dreyApi = fakeApi as DreyApi;

    const service = TestBed.inject(TagService);
    await Promise.resolve();
    expect(service.tags()).toEqual([SAILING]);

    list = [SAILING, { ...SAILING, tag: 'kiel', hasMaster: false, masterPath: null, aliases: [] }];
    await service.refresh();
    expect(service.tags().map((t) => t.tag)).toEqual(['sailing', 'kiel']);
  });

  it('clears the list when the bridge call rejects', async () => {
    const fakeApi: Partial<DreyApi> = {
      listTags: () => Promise.reject(new Error('no vault')),
    };
    window.dreyApi = fakeApi as DreyApi;

    const service = TestBed.inject(TagService);
    await Promise.resolve();
    await Promise.resolve();
    expect(service.tags()).toEqual([]);
  });
});
