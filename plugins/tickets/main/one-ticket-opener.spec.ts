import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Read from the source: the renderer's entry module runs only inside the app (D-27). */
describe('the plugin has one way to open a ticket (D-27)', () => {
  const source = readFileSync(fileURLToPath(new URL('../renderer/index.ts', import.meta.url)), 'utf8');

  it('Create opens through the opener, not the path of its reply', () => {
    const create = source.slice(source.indexOf("invokeBoard('create'"), source.indexOf("create.addEventListener('click', submit)"));
    expect(create).toContain('openCreatedTicket(');
    expect(create).not.toMatch(/documents\.open|openBoardFile/);
  });

  it('a board file route only ever carries a board file', () => {
    expect(source.match(/openBoardFile\(api, [^)]*\)/g)).toEqual(['openBoardFile(api, path)']);
    expect(source).toMatch(/openFile: \(path: string\) => openBoardFile\(api, path\)/);
  });
});
