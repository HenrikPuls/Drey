/**
 * Shared spawn machinery for the CLI backends (ADR-0047): the process
 * analogue of the HTTP providers' `send()`. The base owns everything that
 * leaves the app once per call -- spawn, prompt on stdin, line-wise stdout
 * parsing, abort -> process-tree kill, and the error mapping -- so a
 * concrete CLI provider only describes its arguments and its event
 * dialect (`buildArgs` / `handleLine`).
 *
 * Design notes:
 * - **No timeout** (ADR-0014), like every provider. Cancellation is the
   caller's `AbortSignal`; aborting kills the whole process tree (Windows:
   `taskkill /pid <pid> /T /F` -- a plain kill would orphan CLI child
   processes) and rejects with `name: 'AbortError'`, the same shape the
   fetch `AbortError` has, so `isAbortError` keeps working unchanged.
 * - On Windows the spawn uses `shell: true`, because npm-installed CLI
   shims are `.cmd` files Node cannot exec directly. Everything
   user-controlled that reaches argv (model id, session ref) MUST pass
   `isValidCliToken` (a shell metacharacter there would execute); the
   prompt itself never touches argv -- it goes through stdin.
 * - The HTTP debug log is not fed: its entries are shaped like HTTP
   exchanges (url/status/headers), which a CLI invocation doesn't have.
 * - The child runs with the app's working directory. Scoping a CLI's own
   file tools (claude's Read/Grep) to the vault is a later, deliberate
   step -- the default headless permission posture auto-denies its
   write-class tools, so the safe default is the one that ships.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  LlmCapabilities,
  LlmChatResult,
  ChatMessage,
  flattenMessages,
  LlmUsage,
} from '../../../shared/llm';
import { LlmConnectionTest } from '../../../shared/ipc-api';
import { LlmClient, LlmChatOptions } from '../llm-client';
import { LlmError } from '../llm-errors';

/** `GET /models` keeps its 8 s deadline; `--version` probes are the same class of cheap call. */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Strict token for anything user-controlled that reaches CLI argv. Model
 * ids and session ids are plain tokens (`glm-4.6`,
 * `a1b2c3-…`); anything with whitespace or a shell metacharacter is
 * rejected rather than escaped -- with `shell: true` on Windows an
 * escaping bug would be command execution.
 */
export function isValidCliToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:\/+-]*$/.test(value);
}

/** What a concrete CLI provider's line handler feeds back while parsing. */
export interface CliEventSink {
  /** One incremental text piece (already gated on the caller having passed onDelta). */
  delta(text: string): void;
  /** Replaces the authoritative reply text (a complete assistant/result event). */
  setText(text: string): void;
  /** The provider-side session handle (`--resume` for the next call). */
  sessionRef(id: string): void;
  /** Token accounting, when the event carries it. */
  usage(usage: LlmUsage): void;
}

/**
 * One stdout line, JSON or plain text by dialect. May throw an `LlmError`
 * for a dialect-level failure (a CLI-reported error result) -- the base
 * turns that into the chat rejection.
 */
export type CliLineHandler = (line: string, sink: CliEventSink) => void;

export abstract class CliProviderBase implements LlmClient {
  abstract readonly id: LlmClient['id'];
  abstract capabilities(): LlmCapabilities;

  /** The executable name as it must appear on PATH (`claude`, `copilot`). */
  protected abstract readonly exe: string;
  /** Argv for a chat call; the `-p`-style print flag included. The prompt goes to stdin. */
  protected abstract buildArgs(options: LlmChatOptions): string[];
  /** One stdout line of this CLI's output dialect. */
  protected abstract handleLine: CliLineHandler;

  listModels(): Promise<string[]> {
    // CLIs have no model listing endpoint -- the Settings screen lets the
    // user type the id, exactly like a server without /models.
    return Promise.resolve([]);
  }

  /** Probes `exe --version`: the cheapest "is the CLI installed and runnable" check. */
  async testConnection(): Promise<LlmConnectionTest> {
    try {
      const version = await this.probe(['--version']);
      return {
        ok: true,
        message: `${this.exe} CLI detected${version ? ` (${version})` : ''}. Authentication and model access are the CLI's own.`,
        models: [],
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Could not run ${this.exe} -- ${detail}. Is the CLI installed and on PATH?`,
        models: [],
      };
    }
  }

  /**
   * One CLI round-trip: flatten the transcript to a prompt, spawn, feed
   * stdin, parse stdout line by line, kill on abort, and resolve with what
   * the sink collected. There is no timeout -- the user cancels.
   */
  chat(messages: readonly ChatMessage[], options: LlmChatOptions = {}): Promise<LlmChatResult> {
    const prompt = flattenMessages(messages);
    const args = this.buildArgs(options); // may throw LlmError('disabled' | ...) -- before spawn, by design.
    return new Promise<LlmChatResult>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const child = spawn(this.exe, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });

      let stdoutBuffer = '';
      let finalText = '';
      let sessionRef: string | undefined;
      let usage: LlmUsage | undefined;
      let stderrTail = '';
      let aborted = false;

      const sink: CliEventSink = {
        delta: (text) => options.onDelta?.(text),
        setText: (text) => {
          finalText = text;
        },
        sessionRef: (id) => {
          sessionRef = id;
        },
        usage: (u) => {
          usage = u;
        },
      };

      const rejectAbort = (): void => {
        const err = new Error('Generation cancelled.');
        err.name = 'AbortError';
        finish(() => reject(err));
      };

      if (options.signal) {
        if (options.signal.aborted) {
          killTree(child);
          rejectAbort();
          return;
        }
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            killTree(child);
            rejectAbort();
          },
          { once: true },
        );
      }

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newlineAt = stdoutBuffer.indexOf('\n');
        while (newlineAt !== -1) {
          const line = stdoutBuffer.slice(0, newlineAt).replace(/\r$/, '');
          stdoutBuffer = stdoutBuffer.slice(newlineAt + 1);
          if (line.trim() !== '') {
            try {
              this.handleLine(line, sink);
            } catch (err) {
              killTree(child);
              finish(() => reject(err));
              return;
            }
          }
          newlineAt = stdoutBuffer.indexOf('\n');
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        // Keep only the tail -- CLIs write progress noise, but the last
        // lines are what an error message needs.
        stderrTail = (stderrTail + chunk).slice(-2000);
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const hint =
          err.code === 'ENOENT'
            ? `${this.exe} was not found -- install the CLI and make sure it is on PATH.`
            : err.message;
        finish(() => reject(new LlmError('spawn', `${this.exe}: ${hint}`)));
      });

      child.on('close', (code) => {
        if (aborted) {
          return; // The abort listener already rejected.
        }
        if (code !== 0) {
          const detail = stderrTail.trim().split('\n').slice(-3).join(' | ');
          finish(() =>
            reject(
              new LlmError(
                'spawn',
                `${this.exe} exited with code ${code}${detail ? `: ${detail}` : ''}`,
              ),
            ),
          );
          return;
        }
        finish(() =>
          resolve({
            text: finalText,
            ...(sessionRef !== undefined ? { sessionRef } : {}),
            ...(usage !== undefined ? { usage } : {}),
          }),
        );
      });

      // The prompt rides stdin -- never argv (see the shell note above).
      child.stdin?.on('error', () => {
        /* EPIPE when the CLI exits early: the close handler reports it. */
      });
      child.stdin?.end(prompt);
    });
  }

  /** `exe <args>` with the same spawn settings as chat, first stdout line(s) back. */
  private probe(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.exe, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        killTree(child);
        reject(new LlmError('spawn', `${this.exe} did not answer within ${PROBE_TIMEOUT_MS / 1000}s`));
      }, PROBE_TIMEOUT_MS);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        out += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        err += chunk;
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          e.code === 'ENOENT'
            ? new LlmError('spawn', `${this.exe} was not found on PATH.`)
            : e,
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new LlmError('spawn', `${this.exe} exited with code ${code}: ${err.trim().slice(0, 200)}`),
          );
          return;
        }
        resolve(out.trim().split('\n')[0] ?? '');
      });
    });
  }
}

/** Kill the whole process tree -- a plain kill would orphan CLI children. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
}
