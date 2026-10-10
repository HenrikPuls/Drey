import { Injectable, inject, signal } from '@angular/core';
import { ToolApprovalRequest } from '../../../shared/ipc-api';
import { SettingsService } from '../services/settings.service';

export type ToolApprovalAnswer = 'allow' | 'always' | 'deny';

/**
 * Renderer side of the external tool approval (milestone 63, ADR-0063):
 * a call to `web_fetch` or to a tool of one of the user's MCP servers,
 * whose source is set to "ask", is pushed here from main; the dialog
 * answers allow / always allow / deny. "Always allow" switches that source
 * to `allow` in the config before the call runs.
 *
 * Calls queue: a model may ask for several in one round, and each is its
 * own question.
 */
@Injectable({ providedIn: 'root' })
export class ToolApprovalService {
  private readonly settings = inject(SettingsService);
  private readonly queue = signal<ToolApprovalRequest[]>([]);
  private started = false;

  /** The call being asked about. */
  readonly pending = () => this.queue()[0] ?? null;
  /** How many more are waiting behind it. */
  readonly waiting = () => Math.max(0, this.queue().length - 1);

  start(): void {
    if (this.started || typeof window === 'undefined' || !window.dreyApi) {
      return;
    }
    this.started = true;
    window.dreyApi.onToolApprovalRequest?.((request) => this.enqueue(request));
  }

  enqueue(request: ToolApprovalRequest): void {
    this.queue.update((queue) => [...queue, request]);
  }

  async answer(answer: ToolApprovalAnswer): Promise<void> {
    const request = this.pending();
    if (request === null) {
      return;
    }
    if (answer === 'always') {
      await this.settings.allowToolSourceImmediate(request.source);
    }
    // "Always allow" also answers the calls of the same source already
    // waiting -- asking again right after it would contradict the click.
    const covered = (other: ToolApprovalRequest): boolean =>
      other.id === request.id || (answer === 'always' && other.source === request.source);
    const answered = this.queue().filter(covered);
    this.queue.update((queue) => queue.filter((other) => !covered(other)));
    await Promise.all(
      answered.map((other) => window.dreyApi?.resolveToolApproval?.(other.id, answer !== 'deny')),
    );
  }
}
