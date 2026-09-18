import { BrowserWindow } from 'electron';
import { ExitDecision, IPC_CHANNELS } from '../../shared/ipc-api';

/**
 * The main<->renderer bridge for the save-before-exit prompt (bug-5),
 * structurally a copy of `McpWriteBridge` minus the timeout: every window
 * close funnels through `BrowserWindow 'close'`, main pushes an
 * `exit:confirm-request` to the renderer, and the renderer's
 * `exit:decision` IPC reply resolves it via `resolveDecision`.
 *
 * **No timeout, deliberately** (the one deviation from McpWriteBridge): a
 * timeout would auto-decide the user's exit -- either force-closing against
 * an unanswered "Save all?" or re-prompting after they already chose. If the
 * renderer is truly hung, the window stays open until killed from the
 * taskbar; the session backups (ADR-0043) have preserved all buffer text
 * continuously, so nothing is lost. The renderer's own "Recover input focus"
 * command (`window:recover-input`) is the lighter escape hatch.
 *
 * The request is **readiness-gated**: `wc.send` is fire-and-forget, so a
 * close racing the renderer's bootstrap (the window is closable within the
 * first second, before the app UI has registered its exit listener) would
 * lose the request and leave the window permanently unclosable. The preload
 * reports readiness (`exit:listener-ready`) exactly when the listener exists;
 * requests raised before that are held and delivered on readiness instead.
 */
export class ExitBridge {
  private readonly pending = new Map<number, (decision: ExitDecision) => void>();
  private seq = 0;
  private rendererReady = false;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  /** True while the renderer is still deciding a previous close request. */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /**
   * The renderer's exit listener now exists (fired by the preload's
   * `onExitConfirmRequest` registration). Delivers any request that was
   * raised before this point.
   */
  onRendererReady(): void {
    this.rendererReady = true;
    if (this.pending.size === 0) {
      return;
    }
    const wc = this.getMainWindow()?.webContents;
    if (!wc) {
      return;
    }
    for (const id of [...this.pending.keys()]) {
      wc.send(IPC_CHANNELS.exitConfirmRequest, { id });
    }
  }

  /** Raises the confirm request; resolves with the renderer's decision. */
  requestDecision(): Promise<ExitDecision> {
    const wc = this.getMainWindow()?.webContents;
    if (!wc) {
      // No renderer to ask (window gone / dev without a page) -- nothing to
      // save, nothing to confirm.
      return Promise.resolve('discard');
    }
    const id = ++this.seq;
    return new Promise<ExitDecision>((resolve) => {
      this.pending.set(id, resolve);
      if (this.rendererReady) {
        wc.send(IPC_CHANNELS.exitConfirmRequest, { id });
      }
      // else: held until `onRendererReady` delivers it -- see the class doc.
    });
  }

  /** Resolution of an in-flight request, from the `exit:decision` IPC. */
  resolveDecision(id: number, decision: ExitDecision): void {
    const resolver = this.pending.get(id);
    this.pending.delete(id);
    resolver?.(decision);
  }
}
