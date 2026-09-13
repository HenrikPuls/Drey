import {
  findImageLine,
  imageTargetCandidates,
  imageTargetFromLine,
  imageVaultPathFromUrl,
  parseOcrPayload,
  rawImageTargetFromLine,
} from '../../../plugins/ocr/shared/ocr';

/**
 * Specs for the ocr plugin's click-target contract
 * (`plugins/ocr/shared/ocr.ts`): the strict payload check the main-side
 * `ocr` handler delegates to (bug-10 visible-failure rule), and the two
 * ways a context-menu click resolves to a vault image — the widget
 * `drey-asset://` src reverse map and the raw `![…](…)` line regex. The
 * Angular runner ignores `plugins/**`, so plugin specs live here.
 */

describe('ocr plugin payload contract (plugins/ocr/shared/ocr)', () => {
  it('parses a valid payload with and without a taskId', () => {
    expect(parseOcrPayload({ imageVaultPath: 'attachments/pic.png' })).toEqual({
      imageVaultPath: 'attachments/pic.png',
    });
    expect(
      parseOcrPayload({ imageVaultPath: 'attachments/pic.png', taskId: 'task-1' }),
    ).toEqual({ imageVaultPath: 'attachments/pic.png', taskId: 'task-1' });
  });

  it('rejects a malformed payload visibly (no coercion)', () => {
    expect(() => parseOcrPayload(null)).toThrow(/malformed ocr payload/);
    expect(() => parseOcrPayload({})).toThrow(/malformed ocr payload/);
    expect(() => parseOcrPayload({ imageVaultPath: '' })).toThrow(/malformed ocr payload/);
    expect(() => parseOcrPayload({ imageVaultPath: 42 })).toThrow(/malformed ocr payload/);
    expect(() =>
      parseOcrPayload({ imageVaultPath: 'a.png', taskId: 17 }),
    ).toThrow(/malformed ocr payload/);
  });
});

describe('imageVaultPathFromUrl', () => {
  it('reverses a drey-asset URL, decoding each segment', () => {
    expect(imageVaultPathFromUrl('drey-asset://asset/pics/a%20b.png')).toBe('pics/a b.png');
    expect(imageVaultPathFromUrl('drey-asset://asset/pic.png')).toBe('pic.png');
  });

  it('tolerates the per-vault URL shape (vault id as the host, ADR-0051)', () => {
    expect(imageVaultPathFromUrl('drey-asset://vault-1/asset/pics/a.png')).toBe('pics/a.png');
  });

  it('returns null for http, data and foreign schemes', () => {
    expect(imageVaultPathFromUrl('https://example.com/x.png')).toBeNull();
    expect(imageVaultPathFromUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(imageVaultPathFromUrl('file:///c:/x.png')).toBeNull();
    expect(imageVaultPathFromUrl('')).toBeNull();
  });

  it('returns null for a malformed escape instead of guessing', () => {
    expect(imageVaultPathFromUrl('drey-asset://asset/pic%2.png')).toBeNull();
  });
});

describe('imageTargetFromLine', () => {
  it('resolves a plain target relative to the note folder', () => {
    expect(imageTargetFromLine('before ![alt](pic.png) after', 'daily/2026/n.md')).toBe(
      'daily/2026/pic.png',
    );
    expect(imageTargetFromLine('![alt](pic.png)', 'n.md')).toBe('pic.png');
  });

  it('tolerates the Obsidian size suffix and an angle-bracket target', () => {
    expect(imageTargetFromLine('![a diagram|300](img/x.png)', 'n.md')).toBe('img/x.png');
    expect(imageTargetFromLine('![a|300x200](img/x.png)', 'n.md')).toBe('img/x.png');
    expect(imageTargetFromLine('![alt](<my pics/x.png>)', 'n.md')).toBe('my pics/x.png');
  });

  it('resolves ../ against the note dir but rejects escapes above the vault root', () => {
    expect(imageTargetFromLine('![a](../shared/pic.png)', 'daily/2026/n.md')).toBe(
      'daily/shared/pic.png',
    );
    // daily/2026/ + ../../ = the vault root — still inside, so valid;
    // one more .. would climb above the root.
    expect(imageTargetFromLine('![a](../../pic.png)', 'daily/2026/n.md')).toBe('pic.png');
    expect(imageTargetFromLine('![a](../../../pic.png)', 'daily/2026/n.md')).toBeNull();
  });

  it('rejects http/data/foreign schemes and non-image lines', () => {
    expect(imageTargetFromLine('![a](https://example.com/x.png)', 'n.md')).toBeNull();
    expect(imageTargetFromLine('![a](data:image/png;base64,AA)', 'n.md')).toBeNull();
    expect(imageTargetFromLine('[a link](pic.png)', 'n.md')).toBeNull();
    expect(imageTargetFromLine('plain text', 'n.md')).toBeNull();
  });
});

describe('imageTargetCandidates', () => {
  it('offers note-relative first, then the vault-root reading, deduplicated', () => {
    expect(imageTargetCandidates('pics/a.png', 'chats/2026/09/chat.md')).toEqual([
      'chats/2026/09/pics/a.png',
      'pics/a.png',
    ]);
    expect(imageTargetCandidates('pic.png', 'n.md')).toEqual(['pic.png']);
  });

  it('rejects escapes and scheme targets on both readings', () => {
    expect(imageTargetCandidates('../../etc/x.png', 'a/n.md')).toEqual([]);
    expect(imageTargetCandidates('https://x/y.png', 'n.md')).toEqual([]);
  });
});

describe('rawImageTargetFromLine', () => {
  it('extracts the target as written; null for non-image lines', () => {
    expect(rawImageTargetFromLine('text ![a|300](pics/b.png) more')).toBe('pics/b.png');
    expect(rawImageTargetFromLine('![a](<my pics/b.png>)')).toBe('my pics/b.png');
    expect(rawImageTargetFromLine('![a](https://x/y.png)')).toBeNull();
    expect(rawImageTargetFromLine('no image')).toBeNull();
  });
});

describe('findImageLine', () => {
  it('finds the first line referencing the image (1-based)', () => {
    const buffer = '# Note\n\n![alt](pics/a.png)\ntext\n![again](pics/a.png)';
    expect(findImageLine(buffer, 'pics/a.png', 'n.md')).toBe(3);
  });

  it('matches only the same image and returns null when absent', () => {
    expect(findImageLine('![x](pics/b.png)', 'pics/a.png', 'n.md')).toBeNull();
    expect(findImageLine('', 'pics/a.png', 'n.md')).toBeNull();
  });
});
