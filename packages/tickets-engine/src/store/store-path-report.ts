import { defaultGitRun, type GitRun } from './store-git-probe';

/** The files of a store's checkout that one store change touched; paths relative to the checkout, forward slashes. */
export interface StorePathChange {
  /** Absolute path of the checkout. */
  readonly checkout: string;
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

/**
 * Tells which files of a store's checkout changed (D-28). The change feed knows that the
 * store moved, not what moved, and Drey's Files tree and open tabs need the paths. Every
 * store change is a commit (`dk` writes the files first and moves the ref last), so the
 * diff from the HEAD last reported to the HEAD now is exactly what happened, whoever wrote
 * it: the engine, a run's `dk`, a terminal `dk put`, a sync.
 *
 * Calls are serial: a report while one runs is remembered and runs after it, so a burst of
 * changes costs at most two git rounds.
 */
export class StorePathReporter {
  private head: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly checkout: string,
    private readonly onPaths: (change: StorePathChange) => void,
    private readonly log: (message: string, level?: 'info' | 'warn' | 'error') => void,
    private readonly run: GitRun = defaultGitRun,
  ) {}

  /** Where the first report counts from: run when the feed starts. */
  start(): Promise<void> {
    this.running ??= this.round(true).finally(() => this.settle());
    return this.running;
  }

  /** The store changed: report what moved since the last report. Resolves when no report is running. */
  report(): Promise<void> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = this.round(false).finally(() => this.settle());
    return this.running;
  }

  /** Resolves when no report runs any more: the git child holds the checkout as its working directory. */
  async idle(): Promise<void> {
    while (this.running !== null) {
      await this.running;
    }
  }

  private settle(): void {
    this.running = null;
    if (this.again) {
      this.again = false;
      void this.report();
    }
  }

  private async round(baseline: boolean): Promise<void> {
    let now: string;
    try {
      now = (await this.run(['rev-parse', 'HEAD'], this.checkout)).trim();
    } catch (error) {
      this.log(`tickets: cannot read the store's HEAD: ${messageOf(error)}`, 'warn');
      return;
    }
    const before = this.head;
    if (now === '' || now === before) {
      return;
    }
    this.head = now;
    if (baseline || before === null) {
      return;
    }
    let diff: string;
    try {
      diff = await this.run(['diff', '--name-status', '--no-renames', '-z', before, now], this.checkout);
    } catch (error) {
      this.log(`tickets: cannot list the store's changed files: ${messageOf(error)}`, 'warn');
      return;
    }
    const { changed, deleted } = parseNameStatus(diff);
    if (changed.length > 0 || deleted.length > 0) {
      this.onPaths({ checkout: this.checkout, changed, deleted });
    }
  }
}

/** `git diff --name-status -z`: status and path, NUL-separated. */
export function parseNameStatus(output: string): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  const fields = output.split('\0').map((field) => field.trim());
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const path = fields[i + 1]!.replace(/\\/g, '/');
    if (path !== '') {
      (fields[i]!.startsWith('D') ? deleted : changed).push(path);
    }
  }
  return { changed, deleted };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
