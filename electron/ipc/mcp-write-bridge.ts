import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-api';

/**
 * The main<->renderer bridge for confirming an MCP `vault_write`
 * (ADR-0011 / ADR-0021). `VaultTools` calls `requestConfirmation`, which
 * pushes an `mcp:write-request` to the renderer and parks a promise; the
 * renderer's `mcp:write-decision` IPC reply resolves it via
 * `resolveDecision`. A missing renderer or a timeout defaults to a reject
 * -- an MCP client (local model or a remote one) must never overwrite
 * vault files unattended.
 */
export class McpWriteBridge {
  private readonly pending = new Map<number, (approved: boolean) => void>();
  private seq = 0;
  private static readonly CONFIRM_TIMEOUT_MS = 120_000;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  requestConfirmation(request: {
    path: string;
    before: string;
    after: string;
    mode: 'overwrite' | 'append';
    origin?: 'assistant';
    vaultId?: string;
    vaultName?: string;
  }): Promise<boolean> {
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
      const timer = setTimeout(() => done(false), McpWriteBridge.CONFIRM_TIMEOUT_MS);
      this.pending.set(id, done);
      wc.send(IPC_CHANNELS.mcpWriteRequest, { id, ...request });
    });
  }

  /** Resolve of an in-flight confirmation, from the `mcp:write-decision` IPC. */
  resolveDecision(id: number, approved: boolean): void {
    this.pending.get(id)?.(approved);
  }
}
