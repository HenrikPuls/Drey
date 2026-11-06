import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/**
 * What the engine serves to a browser: the built Mission Control app when it
 * is there, the legacy remote client otherwise (the strangler hand-over, E5b).
 * A build without `dist/mission-control` is an ordinary state: a partial
 * rebuild in a worktree makes one, and the engine must still come up.
 */
export async function clientDirOf(builtApp: string, legacyClient: string): Promise<string> {
  const built = await fsp
    .stat(path.join(builtApp, 'index.html'))
    .then((stat) => stat.isFile())
    .catch(() => false);
  return built ? builtApp : legacyClient;
}
