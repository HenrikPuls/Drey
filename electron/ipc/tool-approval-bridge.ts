import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, ToolApprovalRequest } from '../../shared/ipc-api';

/**
 * The main<->renderer bridge for approving one external tool call
 * (milestone 63, ADR-0063), built like `McpWriteBridge`: the toolbox calls
 * `request`, which pushes `tools:approval-request` and parks a promise;
 * the renderer's `tools:approval-decision` resolves it. No renderer or no
 * answer in time means the call does not run.
 */
export class ToolApprovalBridge {
  private readonly pending = new Map<number, (approved: boolean) => void>();
  private seq = 0;
  private static readonly TIMEOUT_MS = 120_000;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  request(request: Omit<ToolApprovalRequest, 'id'>): Promise<boolean> {
    const wc = this.getMainWindow()?.webContents;
    if (!wc) {
      return Promise.resolve(false);
    }
    const id = ++this.seq;
    return new Promise<boolean>((resolve) => {
      const done = (approved: boolean): void => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          resolve(approved);
        }
      };
      const timer = setTimeout(() => done(false), ToolApprovalBridge.TIMEOUT_MS);
      this.pending.set(id, done);
      wc.send(IPC_CHANNELS.toolsApprovalRequest, { id, ...request });
    });
  }

  resolveDecision(id: number, approved: boolean): void {
    this.pending.get(id)?.(approved);
  }
}
