import { BrowserWindow } from 'electron';
import { IPC_CHANNELS, OpenDocBuffer, OpenDocsReply, OpenDocsRequest } from '../../shared/ipc-api';

type Ask = OpenDocsRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/**
 * The main<->renderer bridge to the editor's open tabs (milestone 78,
 * ADR-0071), built like `McpWriteBridge`: a vault tool asks, the request
 * is pushed as `open-docs:request` and a promise is parked; the renderer's
 * `open-docs:reply` resolves it.
 *
 * Main holds no buffers of its own — the renderer is the only place that
 * knows what an open tab shows. No window, or no answer in time, reads as
 * "nothing is open": the tool then works on the file on disk, as it did
 * before this bridge existed.
 */
export class OpenDocsBridge {
  private readonly pending = new Map<number, (reply: OpenDocsReply) => void>();
  private seq = 0;
  /** A question about buffers is answered from memory at once. */
  private static readonly ASK_TIMEOUT_MS = 5_000;
  /** Applying may save, and a save may stop at the conflict dialog. */
  private static readonly APPLY_TIMEOUT_MS = 120_000;

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  private ask(request: Ask, timeoutMs: number): Promise<OpenDocsReply> {
    const wc = this.getMainWindow()?.webContents;
    if (!wc || wc.isDestroyed()) {
      return Promise.resolve({});
    }
    const id = ++this.seq;
    return new Promise<OpenDocsReply>((resolve) => {
      const done = (reply: OpenDocsReply): void => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          resolve(reply);
        }
      };
      const timer = setTimeout(() => done({}), timeoutMs);
      this.pending.set(id, done);
      wc.send(IPC_CHANNELS.openDocsRequest, { id, ...request });
    });
  }

  /** The buffer of `path` when it is open in a tab, else `null`. */
  async peek(vaultId: string, path: string): Promise<OpenDocBuffer | null> {
    const reply = await this.ask({ kind: 'peek', vaultId, path }, OpenDocsBridge.ASK_TIMEOUT_MS);
    return reply.buffers?.[0] ?? null;
  }

  /** Every open vault file with unsaved changes. */
  async dirty(): Promise<OpenDocBuffer[]> {
    const reply = await this.ask({ kind: 'dirty' }, OpenDocsBridge.ASK_TIMEOUT_MS);
    return reply.buffers ?? [];
  }

  /** Puts `content` into the open tab of `path`; `save` also writes it to disk. */
  async apply(
    vaultId: string,
    path: string,
    content: string,
    options: { save: boolean; origin: string },
  ): Promise<{ applied: boolean; saved: boolean }> {
    const reply = await this.ask(
      { kind: 'apply', vaultId, path, content, ...options },
      OpenDocsBridge.APPLY_TIMEOUT_MS,
    );
    return { applied: reply.applied === true, saved: reply.saved === true };
  }

  /** A file was moved on disk: its tab follows. */
  async moved(vaultId: string, from: string, to: string): Promise<void> {
    await this.ask({ kind: 'moved', vaultId, from, to }, OpenDocsBridge.ASK_TIMEOUT_MS);
  }

  /** A file was deleted on disk: its tab closes. */
  async closed(vaultId: string, path: string): Promise<void> {
    await this.ask({ kind: 'closed', vaultId, path }, OpenDocsBridge.ASK_TIMEOUT_MS);
  }

  /** The renderer's answer, from the `open-docs:reply` IPC. */
  resolveReply(id: number, reply: OpenDocsReply): void {
    this.pending.get(id)?.(reply ?? {});
  }
}
