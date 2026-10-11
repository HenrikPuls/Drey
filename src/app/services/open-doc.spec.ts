import { CaretMemoryStore } from './caret-memory';
import {
  OpenDoc,
  baseName,
  docKey,
  helpDoc,
  isDirty,
  isMarkdownPath,
  isReplaceable,
  pathOfKey,
  pluginDoc,
  retargeted,
  splitEol,
  textDoc,
  vaultIdOfKey,
  viewerDoc,
} from './open-doc';

function note(patch: Partial<OpenDoc> = {}): OpenDoc {
  return { ...textDoc('notes/a.md', 'v1', 'text', 10, true, 'live'), ...patch };
}

describe('open-doc', () => {
  describe('tab keys', () => {
    it('scopes a vault path by its vault id', () => {
      expect(docKey('v1', 'notes/a.md')).toBe('v1::notes/a.md');
    });

    it('uses the bare string for a vault-less doc', () => {
      expect(docKey(null, 'untitled.md')).toBe('untitled.md');
      expect(docKey('', 'untitled.md')).toBe('untitled.md');
    });

    it('splits a key back into vault id and path', () => {
      expect(vaultIdOfKey('v1::notes/a.md')).toBe('v1');
      expect(pathOfKey('v1::notes/a.md')).toBe('notes/a.md');
    });

    it('reads a bare key as a path without a vault', () => {
      expect(vaultIdOfKey('browser://1')).toBeNull();
      expect(pathOfKey('browser://1')).toBe('browser://1');
    });
  });

  describe('paths', () => {
    it('takes the last segment as the name', () => {
      expect(baseName('daily/2026/a.md')).toBe('a.md');
      expect(baseName('a.md')).toBe('a.md');
    });

    it('treats Markdown extensions and the empty path as Markdown', () => {
      expect(isMarkdownPath('a.md')).toBe(true);
      expect(isMarkdownPath('a.MDX')).toBe(true);
      expect(isMarkdownPath('')).toBe(true);
      expect(isMarkdownPath('a.json')).toBe(false);
    });
  });

  describe('splitEol', () => {
    it('normalizes CRLF and remembers it', () => {
      expect(splitEol('a\r\nb\r\n')).toEqual({ text: 'a\nb\n', eol: '\r\n' });
    });

    it('keeps LF text as it is', () => {
      expect(splitEol('a\nb')).toEqual({ text: 'a\nb', eol: '\n' });
    });
  });

  describe('textDoc', () => {
    it('opens clean, in the given Markdown mode', () => {
      const doc = textDoc('notes/a.md', 'v1', 'x\r\ny', 42, true, 'source');
      expect(doc).toMatchObject({
        key: 'v1::notes/a.md',
        name: 'a.md',
        kind: 'text',
        savedContent: 'x\ny',
        bufferContent: 'x\ny',
        eol: '\r\n',
        modifiedMs: 42,
        existsOnDisk: true,
        viewMode: 'source',
        askOnSave: false,
      });
      expect(isDirty(doc)).toBe(false);
    });

    it('opens a code file in source mode whatever the Markdown mode is', () => {
      expect(textDoc('a.json', 'v1', '{}', 0, true, 'live').viewMode).toBe('source');
    });
  });

  describe('bufferless docs', () => {
    it('builds an image / PDF viewer tab without a buffer', () => {
      const doc = viewerDoc('pdf', 'docs/a.pdf', 'v1');
      expect(doc).toMatchObject({ key: 'v1::docs/a.pdf', name: 'a.pdf', kind: 'pdf', bufferContent: '' });
      expect(isDirty(doc)).toBe(false);
    });

    it('keys a plugin tab by the key its owner minted', () => {
      expect(pluginDoc('browser', 'browser://1', 'New tab')).toMatchObject({
        vaultId: null,
        key: 'browser://1',
        path: 'browser://1',
        name: 'New tab',
        kind: 'browser',
      });
    });

    it('builds a pinned, clean help tab in view mode', () => {
      const doc = helpDoc('help/manual.md', 'Manual', '# Manual', 'manual/');
      expect(doc).toMatchObject({ pinned: true, viewMode: 'view', help: { assetBase: 'manual/' } });
      expect(isDirty(doc)).toBe(false);
    });
  });

  describe('isReplaceable', () => {
    it('accepts a clean, unpinned file tab', () => {
      expect(isReplaceable(note())).toBe(true);
      expect(isReplaceable(viewerDoc('image', 'a.png', 'v1'))).toBe(true);
    });

    it('keeps a dirty tab', () => {
      expect(isReplaceable(note({ bufferContent: 'edited' }))).toBe(false);
    });

    it('keeps a pinned tab', () => {
      expect(isReplaceable(note({ pinned: true }))).toBe(false);
    });

    it('keeps a plugin tab', () => {
      expect(isReplaceable(pluginDoc('browser', 'browser://1', 'New tab'))).toBe(false);
    });
  });

  describe('retargeted', () => {
    it('moves identity to the new key and keeps the buffer', () => {
      const moved = retargeted(note({ bufferContent: 'edited', pinned: true }), 'v2::archive/b.md');
      expect(moved).toMatchObject({
        key: 'v2::archive/b.md',
        vaultId: 'v2',
        path: 'archive/b.md',
        name: 'b.md',
        bufferContent: 'edited',
        savedContent: 'text',
        pinned: true,
      });
    });
  });
});

describe('CaretMemoryStore', () => {
  it('returns what was recorded for a key', () => {
    const store = new CaretMemoryStore();
    store.record('a', { head: 5, scrollTop: 100 });
    expect(store.get('a')).toEqual({ head: 5, scrollTop: 100 });
    expect(store.get('b')).toBeUndefined();
  });

  it('drops the oldest key past the limit', () => {
    const store = new CaretMemoryStore(2);
    store.record('a', { head: 1, scrollTop: 0 });
    store.record('b', { head: 2, scrollTop: 0 });
    store.record('c', { head: 3, scrollTop: 0 });
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toEqual({ head: 2, scrollTop: 0 });
    expect(store.get('c')).toEqual({ head: 3, scrollTop: 0 });
  });

  it('updates a known key at the limit without dropping another', () => {
    const store = new CaretMemoryStore(2);
    store.record('a', { head: 1, scrollTop: 0 });
    store.record('b', { head: 2, scrollTop: 0 });
    store.record('a', { head: 9, scrollTop: 4 });
    expect(store.get('a')).toEqual({ head: 9, scrollTop: 4 });
    expect(store.get('b')).toEqual({ head: 2, scrollTop: 0 });
  });
});
