import {
  extensionOf,
  externalFileKind,
  stagedAttachmentsDir,
  uniqueStagedName,
} from '../../../plugins/assistant/shared/stage';

/**
 * Specs for the external-file staging rules (`plugins/assistant/shared/
 * stage.ts`): which files are attachable at all, where staged copies land,
 * and how name collisions in the target folder resolve. The Angular runner
 * ignores `plugins/**`, so plugin specs live here.
 */

describe('assistant plugin staging rules (plugins/assistant/shared/stage)', () => {
  it('routes by extension: images, text files, nothing else', () => {
    expect(externalFileKind('photo.PNG')).toBe('image');
    expect(externalFileKind('C:\\Users\\x\\pic.jpeg')).toBe('image');
    expect(externalFileKind('notes.md')).toBe('file');
    expect(externalFileKind('/tmp/export.csv')).toBe('file');
    expect(externalFileKind('app.ts')).toBe('file');
    expect(externalFileKind('virus.exe')).toBeNull();
    expect(externalFileKind('archive.zip')).toBeNull();
    expect(externalFileKind('noextension')).toBeNull();
  });

  it('reads the extension from the basename only', () => {
    expect(extensionOf('a/b/c.d/report.md')).toBe('md');
    expect(extensionOf('C:\\dir\\FILE.TXT')).toBe('txt');
    expect(extensionOf('noext')).toBe('');
    expect(extensionOf('.gitignore')).toBe('gitignore');
  });

  it('keeps the original name when it is free', () => {
    expect(uniqueStagedName('report.md', ['other.md', 'summary.txt'])).toBe('report.md');
    expect(uniqueStagedName('report.md', [])).toBe('report.md');
  });

  it('suffixes collisions with -2, -3 … case-insensitively', () => {
    expect(uniqueStagedName('report.md', ['report.md'])).toBe('report-2.md');
    expect(uniqueStagedName('report.md', ['REPORT.MD', 'report-2.md'])).toBe('report-3.md');
    expect(uniqueStagedName('noext', ['noext'])).toBe('noext-2');
  });

  it('lands staged files in attachments/ beside the reference note', () => {
    expect(stagedAttachmentsDir('chats/2026/09/2026-09-13-topic.md')).toBe(
      'chats/2026/09/attachments',
    );
    expect(stagedAttachmentsDir('inbox.md')).toBe('attachments');
  });
});
