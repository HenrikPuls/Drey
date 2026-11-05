import { execFile } from 'node:child_process';

/**
 * The two cheap git questions behind change detection (E14-8) — plain `git`
 * plumbing, no `dk` feature involved:
 *
 * - {@link headFingerprint}: the checkout's HEAD commit (~50 ms). `dk` writes the
 *   files first and moves the ref last, so a moved HEAD means the files are
 *   already there. The feed compares it with the HEAD it last announced: a
 *   foreign write the file watcher did not report still shows up;
 * - {@link remoteMovedProbe}: has the remote branch moved since the checkout's
 *   HEAD? `git ls-remote` + `rev-parse` (~150 ms against ~400 ms for a `dk sync`
 *   that finds nothing to fetch); the periodic sync round skips the sync on "no".
 *
 * Every failure answers "unknown" (null / true): the callers then do the full
 * work, so a probe can only save work, never hide a change.
 */

export type GitRun = (args: readonly string[], cwd: string) => Promise<string>;

export const defaultGitRun: GitRun = (args, cwd) =>
  new Promise<string>((resolve, reject) => {
    execFile('git', [...args], { cwd, windowsHide: true, timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => {
      if (error !== null) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    });
  });

/** The checkout's HEAD commit, or null when git cannot say. */
export function headFingerprint(dir: string, run: GitRun = defaultGitRun): () => Promise<string | null> {
  return async () => {
    try {
      const head = await run(['rev-parse', 'HEAD'], dir);
      return head === '' ? null : head;
    } catch {
      return null;
    }
  };
}

/** True when the remote branch may have moved (also whenever the probe cannot tell). */
export function remoteMovedProbe(dir: string, run: GitRun = defaultGitRun): () => Promise<boolean> {
  let upstream: { readonly remote: string; readonly branch: string } | null | undefined;
  return async () => {
    try {
      if (upstream === undefined) {
        const tracking = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir).catch(() => '');
        const slash = tracking.indexOf('/');
        upstream = slash > 0 ? { remote: tracking.slice(0, slash), branch: tracking.slice(slash + 1) } : null;
      }
      if (upstream === null) {
        return true;
      }
      const listed = await run(['ls-remote', upstream.remote, `refs/heads/${upstream.branch}`], dir);
      const tip = listed.split(/\s+/)[0] ?? '';
      if (tip === '') {
        return true;
      }
      return tip !== (await run(['rev-parse', 'HEAD'], dir));
    } catch {
      return true;
    }
  };
}
