import { Injectable, inject } from '@angular/core';
import { McpWriteRequest } from '../../../shared/ipc-api';
import { pickPreviewStyle } from '../../../shared/text-diff';
import { ConfirmationService } from '../llm';
import { VaultService } from '../vault';

/**
 * Renderer side of the vault MCP server (ADR-0021):
 *
 *  - a `vault_write` an MCP client asked for is pushed here as a
 *    `McpWriteRequest`; it goes through the shared confirmation diff and
 *    the decision is sent back (`resolveMcpWrite`). YOLO mode skips this
 *    entirely -- the main process never sends the request.
 *
 * The tree refresh after a write used to live here too; since ADR-0045
 * the `vault:changed` push is subscribed by `VaultService` for every
 * change source (watcher, manual refresh, MCP write), so this service
 * only handles the confirmation flow.
 *
 * Instantiated once from `App`; the subscriptions live for the app's
 * lifetime, so there is no teardown.
 */
@Injectable({ providedIn: 'root' })
export class McpBridgeService {
  private readonly confirmation = inject(ConfirmationService);

  private started = false;

  start(): void {
    if (this.started || typeof window === 'undefined' || !window.dreyApi) {
      return;
    }
    this.started = true;

    window.dreyApi.onMcpWriteRequest?.((request) => void this.confirm(request));
  }

  private async confirm(request: McpWriteRequest): Promise<void> {
    let approved = false;
    try {
      approved = await this.confirmation.request({
        title: 'Apply a change from an MCP client',
        summary: `${request.mode === 'append' ? 'Append to' : 'Overwrite'} ${request.path}`,
        previewStyle: pickPreviewStyle(request.before, request.after),
        before: request.before,
        after: request.after,
        triggerId: null,
      });
    } finally {
      await window.dreyApi?.resolveMcpWrite?.(request.id, approved);
    }
  }
}
