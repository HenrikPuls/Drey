import { uniqueCopyName } from './unique-name';

describe('uniqueCopyName', () => {
  it('appends " copy" before a file extension', () => {
    expect(uniqueCopyName('plan.md', ['plan.md'])).toBe('plan copy.md');
  });

  it('appends " copy" to an extensionless name (a folder)', () => {
    expect(uniqueCopyName('archive', ['archive'])).toBe('archive copy');
  });

  it('counts up when earlier copies are taken', () => {
    expect(uniqueCopyName('plan.md', ['plan.md', 'plan copy.md'])).toBe('plan copy 2.md');
    expect(uniqueCopyName('plan.md', ['plan.md', 'plan copy.md', 'plan copy 2.md'])).toBe(
      'plan copy 3.md',
    );
  });

  it('does not stack " copy copy" when duplicating a copy', () => {
    expect(uniqueCopyName('plan copy.md', ['plan copy.md'])).toBe('plan copy 2.md');
    expect(uniqueCopyName('plan copy 2.md', ['plan copy 2.md'])).toBe('plan copy.md');
  });

  it('returns the plain " copy" name when nothing collides', () => {
    expect(uniqueCopyName('plan.md', [])).toBe('plan copy.md');
    expect(uniqueCopyName('plan.md', ['other.md'])).toBe('plan copy.md');
  });

  it('keeps a leading-dot name whole (no false extension split)', () => {
    expect(uniqueCopyName('.gitignore', ['.gitignore'])).toBe('.gitignore copy');
  });
});
