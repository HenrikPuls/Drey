import { Injectable, inject } from '@angular/core';
import { OpenRequest } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';

/**
 * Bridges files the OS hands to Drey (Explorer "Open with", a default-program
 * association, `drey.exe notes.md` -- ADR-0054) to the editor. Main classifies
 * each file: inside a registered vault it is an ordinary vault tab, anywhere
 * else it becomes a pinned external tab that saves back in place.
 *
 * Two arrival paths, on purpose: the launch's own files are PULLED once the
 * app has finished starting (`onStartupSettled`, so the session restore has
 * already run and the file lands active on top of it; a push at cold start
 * would fire before this listener exists), and every later launch while the
 * app runs is a PUSH (`start`).
 *
 * Logic lives here, not in a component (CLAUDE.md).
 */
@Injectable({ providedIn: 'root' })
export class ExternalOpenService {
  private readonly editor = inject(EditorService);
  private unsubscribe: (() => void) | null = null;
  private settled = false;

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /** Subscribes to later launches. Called once from `App`; idempotent. */
  start(): void {
    if (this.unsubscribe || typeof this.api?.onOpenRequest !== 'function') {
      return;
    }
    this.unsubscribe = this.api.onOpenRequest((requests) => void this.open(requests));
  }

  /**
   * `App` calls this once startup (vault registry, settings, session restore)
   * is done: drains the launch's own files. Idempotent -- only the first call
   * pulls, which is also what tells main the push path is now safe.
   * Resolves to how many files the launch carried (0 on a repeat call), so
   * `App` can skip its daily-note fallback when the OS already opened one.
   */
  async onStartupSettled(): Promise<number> {
    if (this.settled || typeof this.api?.takePendingOpenRequests !== 'function') {
      return 0;
    }
    this.settled = true;
    const requests = await this.api.takePendingOpenRequests();
    await this.open(requests);
    return requests.length;
  }

  private async open(requests: readonly OpenRequest[]): Promise<void> {
    for (const request of requests) {
      if (request.kind === 'vault') {
        await this.editor.openFile(request.path, request.vaultId);
      } else {
        await this.editor.openExternalFile(request.path);
      }
    }
  }
}
