import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn(async (): Promise<string> => '') } }));

import { shell } from 'electron';
import { localPathFromFileHref, openDocumentInDefaultProgram } from './open-document';

describe('localPathFromFileHref', () => {
  it.runIf(process.platform === 'win32')('decodes a local Windows file link', () => {
    expect(localPathFromFileHref('file:///C:/Docs/My%20report%20%28v2%29.docx')).toBe(
      'C:\\Docs\\My report (v2).docx',
    );
  });

  it('refuses a network share', () => {
    expect(() => localPathFromFileHref('file://server/share/a.docx')).toThrow(/network share/);
  });

  it('refuses anything that is not a file link', () => {
    expect(() => localPathFromFileHref('https://example.com/a.docx')).toThrow(/not a file link/);
    expect(() => localPathFromFileHref('not a url')).toThrow(/not a valid file link/);
  });
});

describe('openDocumentInDefaultProgram', () => {
  it('never hands a type off the allowlist to the OS', async () => {
    await expect(openDocumentInDefaultProgram(process.execPath)).rejects.toThrow(/not opened/);
    await expect(openDocumentInDefaultProgram('C:/x/run.bat')).rejects.toThrow(/not opened/);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('reports a missing document instead of asking the OS', async () => {
    await expect(openDocumentInDefaultProgram('C:/definitely/missing/a.docx')).rejects.toThrow(
      /File not found/,
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});
