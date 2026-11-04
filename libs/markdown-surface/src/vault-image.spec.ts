import { assetUrlToVaultPath, resolveVaultImageCandidates, resolveVaultImageUrl } from './vault-image';

describe('resolveVaultImageUrl', () => {
  it('passes http(s) and data URLs through unchanged', () => {
    expect(resolveVaultImageUrl('notes/a.md', 'https://x/y.png')).toBe('https://x/y.png');
    expect(resolveVaultImageUrl('notes/a.md', 'data:image/png;base64,AAA')).toBe(
      'data:image/png;base64,AAA',
    );
  });

  it('resolves a relative path against the note folder into a drey-asset URL', () => {
    expect(resolveVaultImageUrl('sailing/trip.md', 'img/pic.png')).toBe(
      'drey-asset://asset/sailing/img/pic.png',
    );
    expect(resolveVaultImageUrl('a/b/note.md', '../shared/x.png')).toBe(
      'drey-asset://asset/a/shared/x.png',
    );
    expect(resolveVaultImageUrl('note.md', 'pic.png')).toBe('drey-asset://asset/pic.png');
  });

  it('rejects paths that escape the vault or use an unknown scheme', () => {
    expect(resolveVaultImageUrl('a/note.md', '../../etc/passwd')).toBeNull();
    expect(resolveVaultImageUrl('note.md', 'file:///etc/passwd')).toBeNull();
    expect(resolveVaultImageUrl('note.md', '')).toBeNull();
  });

  it('encodes spaces in file names', () => {
    expect(resolveVaultImageUrl('note.md', 'my pic.png')).toBe('drey-asset://asset/my%20pic.png');
  });
});

describe('resolveVaultImageCandidates', () => {
  it('offers note-relative first, then the vault-root reading', () => {
    expect(resolveVaultImageCandidates('sailing/trip.md', 'img/pic.png')).toEqual([
      'drey-asset://asset/sailing/img/pic.png',
      'drey-asset://asset/img/pic.png',
    ]);
  });

  it('a bare name also tries the attachments folders (milestone 31)', () => {
    expect(resolveVaultImageCandidates('sailing/trip.md', 'Pasted image 1.png')).toEqual([
      'drey-asset://asset/sailing/Pasted%20image%201.png',
      'drey-asset://asset/Pasted%20image%201.png',
      'drey-asset://asset/sailing/attachments/Pasted%20image%201.png',
      'drey-asset://asset/attachments/Pasted%20image%201.png',
    ]);
    // A reference with a directory component keeps the two classic candidates.
    expect(resolveVaultImageCandidates('a/n.md', 'sub/pic.png')).toEqual([
      'drey-asset://asset/a/sub/pic.png',
      'drey-asset://asset/sub/pic.png',
    ]);
  });

  it('deduplicates when the note lives at the vault root', () => {
    expect(resolveVaultImageCandidates('note.md', 'pic.png')).toEqual([
      'drey-asset://asset/pic.png',
      'drey-asset://asset/attachments/pic.png',
    ]);
  });

  it('passes http(s)/data through as the single candidate, unresolvable to none', () => {
    expect(resolveVaultImageCandidates('a/n.md', 'https://x/y.png')).toEqual(['https://x/y.png']);
    expect(resolveVaultImageCandidates('a/n.md', 'file:///etc/passwd')).toEqual([]);
    expect(resolveVaultImageCandidates('a/n.md', '../../etc/passwd')).toEqual([]);
  });
});

describe('assetUrlToVaultPath (ADR-0052)', () => {
  it('maps a vault-scoped asset URL back to vaultId + path', () => {
    expect(assetUrlToVaultPath('drey-asset://v1/asset/attachments/doc.pdf')).toEqual({
      vaultId: 'v1',
      path: 'attachments/doc.pdf',
    });
  });

  it('decodes percent-escaped path segments', () => {
    expect(assetUrlToVaultPath('drey-asset://v1/asset/attachments/my%20doc.pdf')).toEqual({
      vaultId: 'v1',
      path: 'attachments/my doc.pdf',
    });
  });

  it('maps the host-less legacy form to the active vault (vaultId null)', () => {
    expect(assetUrlToVaultPath('drey-asset://asset/attachments/doc.pdf')).toEqual({
      vaultId: null,
      path: 'attachments/doc.pdf',
    });
  });

  it('rejects non-asset URLs', () => {
    expect(assetUrlToVaultPath('https://x/y.png')).toBeNull();
    expect(assetUrlToVaultPath('data:image/png;base64,AAA')).toBeNull();
    expect(assetUrlToVaultPath('attachments/doc.pdf')).toBeNull();
  });
});
