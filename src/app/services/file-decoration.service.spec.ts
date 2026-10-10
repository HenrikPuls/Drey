import { TestBed } from '@angular/core/testing';
import { FileDecorationService } from './file-decoration.service';

describe('FileDecorationService', () => {
  let service: FileDecorationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(FileDecorationService);
  });

  it('decorates the file with badge and tooltip, its folders with the tone only', () => {
    service.set('git', 'v1', [{ path: 'docs/arch/intro.md', badge: 'M', tone: 'modified', tooltip: 'Modified' }]);

    expect(service.decorationFor('v1', 'docs/arch/intro.md')).toEqual({
      tone: 'modified',
      badge: 'M',
      tooltip: 'Modified',
    });
    expect(service.decorationFor('v1', 'docs/arch')).toEqual({ tone: 'modified', badge: null, tooltip: null });
    expect(service.decorationFor('v1', 'docs')).toEqual({ tone: 'modified', badge: null, tooltip: null });
    expect(service.decorationFor('v1', 'other.md')).toBeNull();
    expect(service.decorationFor('v2', 'docs')).toBeNull();
  });

  it('gives a folder the strongest tone among its descendants, deleted files included', () => {
    service.set('git', 'v1', [
      { path: 'a/new.md', badge: 'U', tone: 'untracked' },
      { path: 'a/gone.md', badge: 'D', tone: 'deleted' },
      { path: 'b/x/clash.md', badge: '!', tone: 'conflict' },
      { path: 'b/edit.md', badge: 'M', tone: 'modified' },
    ]);

    expect(service.decorationFor('v1', 'a')?.tone).toBe('deleted');
    expect(service.decorationFor('v1', 'b')?.tone).toBe('conflict');
    expect(service.decorationFor('v1', 'b/x')?.tone).toBe('conflict');
  });

  it('replaces a vault\'s set, and clears it with null or an empty list', () => {
    service.set('git', 'v1', [{ path: 'a.md', badge: 'M', tone: 'modified' }]);
    service.set('git', 'v1', [{ path: 'b.md', badge: 'A', tone: 'added' }]);
    expect(service.decorationFor('v1', 'a.md')).toBeNull();
    expect(service.decorationFor('v1', 'b.md')?.badge).toBe('A');

    service.set('git', 'v1', null);
    expect(service.decorationFor('v1', 'b.md')).toBeNull();
  });

  it('keeps plugins apart: clearing one leaves the other\'s decorations', () => {
    service.set('git', 'v1', [{ path: 'a.md', badge: 'M', tone: 'modified' }]);
    service.set('other', 'v1', [{ path: 'b.md', badge: 'U', tone: 'untracked' }]);

    service.clear('git');

    expect(service.decorationFor('v1', 'a.md')).toBeNull();
    expect(service.decorationFor('v1', 'b.md')?.badge).toBe('U');
  });
});
