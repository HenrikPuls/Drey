/**
 * The model picker's source (req-46): the models a worker CLI offers.
 * OpenCode lists them itself (`opencode models`, one `providerID/modelID`
 * per line); Claude Code has no listing, so its stable aliases stand in.
 * A failed lookup is an answer, not an error: the picker stays a free
 * text field and shows why the list is empty.
 */
import { execFile } from 'node:child_process';

export interface WorkerModels {
  readonly worker: string;
  readonly models: readonly string[];
  /** Why the list is empty or short, shown beside the picker. */
  readonly note: string | null;
}

const CLAUDE_CODE_MODELS: readonly string[] = ['opus', 'sonnet', 'haiku'];
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: WorkerModels }>();

/** The `providerID/modelID` lines of `opencode models`, ANSI stripped. */
export function parseOpencodeModels(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
    if (/^[\w.-]+\/\S+$/.test(line)) {
      seen.add(line);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function run(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      // The npm shims are `.cmd` files on Windows; only the shell resolves them.
      { shell: process.platform === 'win32', windowsHide: true, timeout: 20_000, maxBuffer: 4_000_000 },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    );
  });
}

export async function listWorkerModels(
  worker: string,
  exec: (cmd: string, args: readonly string[]) => Promise<string> = run,
  now: () => number = Date.now,
): Promise<WorkerModels> {
  if (worker === 'claude-code') {
    return { worker, models: CLAUDE_CODE_MODELS, note: 'Aliases; a full model id also works.' };
  }
  if (worker !== 'opencode') {
    return { worker, models: [], note: 'A manual column has no worker.' };
  }
  const hit = cache.get(worker);
  if (hit !== undefined && now() - hit.at < CACHE_MS) {
    return hit.value;
  }
  let value: WorkerModels;
  try {
    const models = parseOpencodeModels(await exec('opencode', ['models']));
    value = {
      worker,
      models,
      note: models.length === 0 ? 'opencode listed no models; type providerID/modelID.' : null,
    };
  } catch {
    // Not cached: the owner may install or sign in and look again.
    return { worker, models: [], note: 'Could not run "opencode models"; type providerID/modelID.' };
  }
  cache.set(worker, { at: now(), value });
  return value;
}
