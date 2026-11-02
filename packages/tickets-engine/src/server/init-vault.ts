/**
 * The engine CLI's `init <dir>` (M112) — the `git init` for a tickets
 * repository: creates the directory tree, writes the `_meta` scaffold
 * (pipeline with the priority vocabulary, repos, the shipped prompts),
 * makes the numbered phase directories, and — when git is available —
 * turns the target into a repository with one initial commit. Both doors
 * share `core/init-scaffold`: the desk's empty-state initialize uses the
 * same texts for an already-registered vault.
 *
 * All IO sits behind `InitIo` so the specs run the real routine against
 * memory; the CLI wires node's fs and the plain `git` executable.
 */
import { initPhaseDirs, initScaffoldFiles, PIPELINE_PATH, PROMPTS_DIR } from '../core/init-scaffold';

export interface InitIo {
  readonly mkdir: (dir: string) => Promise<void>;
  readonly exists: (file: string) => Promise<boolean>;
  readonly writeFile: (file: string, text: string) => Promise<void>;
  readonly git: {
    /** One plain git run (`git <args>`) in `cwd`; rejects on failure. */
    readonly run: (cwd: string, args: readonly string[]) => Promise<string>;
  };
  readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

export type InitResult =
  | { readonly ok: true; readonly root: string; readonly warning: string | null }
  | { readonly ok: false; readonly error: string };

export async function initVault(target: string, prompts: ReadonlyMap<string, string>, io: InitIo): Promise<InitResult> {
  await io.mkdir(target);
  const pipelineFile = `${target}/${PIPELINE_PATH}`;
  if (await io.exists(pipelineFile)) {
    return { ok: false, error: `${target} is already a tickets repository — ${PIPELINE_PATH} exists` };
  }
  const files = initScaffoldFiles();
  const promptFiles = [...prompts.entries()].map(([ref, text]) => ({
    path: `${PROMPTS_DIR}/${ref}.md`,
    text,
  }));
  for (const file of [...files, ...promptFiles]) {
    const dir = file.path.split('/').slice(0, -1).join('/');
    if (dir !== '') {
      await io.mkdir(`${target}/${dir}`);
    }
    await io.writeFile(`${target}/${file.path}`, file.text);
  }
  for (const dir of initPhaseDirs()) {
    await io.mkdir(`${target}/${dir}`);
  }

  // git is an upgrade, never a gate: an unversioned vault works (the
  // board shows the unversioned warning; transitions still move).
  let warning: string | null = null;
  try {
    await io.git.run(target, ['init']);
    const paths = [...files, ...promptFiles].map((file) => file.path);
    await io.git.run(target, ['add', '--', ...paths]);
    await io.git.run(target, ['commit', '-m', 'tickets: initialize board']);
    io.log(`git repository initialized with one commit ('tickets: initialize board')`);
  } catch (error) {
    warning = `git skipped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
    io.log(warning, 'warn');
  }
  return { ok: true, root: target, warning };
}
