import { resolveVaultImageUrl } from './vault-image';

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
