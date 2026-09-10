import { app } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * A flat directory of plain-text backups under the OS user-data dir
 * (`<userData>/session-backups/`), one file per id (ADR-0043).
 *
 * It holds the text of editor tabs that have nothing on disk to reload
 * from on the next launch: a never-saved scratch tab, or unsaved edits to
 * a real file. The session layout / tab list itself lives in the
 * renderer's `localStorage` (like the dock layout) -- only this content
 * needs a real file, because it can be large and must not be lost.
 *
 * `id` is always a renderer-minted UUID; every entry point re-validates it
 * so a crafted id can't escape the directory.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionBackupStore {
  private readonly dir = path.join(app.getPath('userData'), 'session-backups');

  private file(id: string): string | null {
    return UUID.test(id) ? path.join(this.dir, `${id}.txt`) : null;
  }

  async write(id: string, content: string): Promise<void> {
    const file = this.file(id);
    if (!file) {
      return;
    }
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(file, content, 'utf8');
  }

  async read(id: string): Promise<string | null> {
    const file = this.file(id);
    if (!file) {
      return null;
    }
    try {
      return await fsp.readFile(file, 'utf8');
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    try {
      const names = await fsp.readdir(this.dir);
      return names
        .filter((n) => n.endsWith('.txt'))
        .map((n) => n.slice(0, -4))
        .filter((id) => UUID.test(id));
    } catch {
      return [];
    }
  }

  async delete(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const file = this.file(id);
        if (file) {
          await fsp.rm(file, { force: true });
        }
      }),
    );
  }
}
