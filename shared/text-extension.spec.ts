import { textExtension } from './text-extension';

describe('textExtension', () => {
  it('accepts common text file names', () => {
    for (const name of [
      'notes.txt',
      'README.md',
      'data.csv',
      'config.yaml',
      'a/b/c.json',
      'snippet.ts',
      'style.scss',
      'script.py',
      'query.sql',
      'server.log',
    ]) {
      expect(textExtension(name)).toBe(true);
    }
  });

  it('accepts a bare extension, with or without a dot, any case', () => {
    expect(textExtension('md')).toBe(true);
    expect(textExtension('.MD')).toBe(true);
    expect(textExtension('  .Csv ')).toBe(true);
  });

  it('accepts a few extensionless text file names', () => {
    expect(textExtension('Makefile')).toBe(true);
    expect(textExtension('.gitignore')).toBe(true);
  });

  it('rejects binaries, archives and unknowns', () => {
    for (const name of [
      'photo.png',
      'doc.pdf',
      'app.exe',
      'archive.tar.gz',
      'font.woff2',
      'clip.mp4',
      '',
      'no-extension-file',
    ]) {
      expect(textExtension(name)).toBe(false);
    }
  });
});
