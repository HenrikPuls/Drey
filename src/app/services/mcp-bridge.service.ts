import { Injectable, inject } from '@angular/core';
import { McpWriteRequest } from '../../../shared/ipc-api';
import { pickPreviewStyle } from '../../../shared/text-diff';
import { TaskService } from '../tasks';
import { ConfirmationService } from '../llm';
import { VaultService } from '../vault';

/**
 * Renderer side of the vault MCP server (ADR-0021):
 *
 *  - a `vault_write` an MCP client asked for is pushed here as a
 *    `McpWriteRequest`; it goes through the shared confirmation diff and
 *    the decision is sent back (`resolveMcpWrite`). YOLO mode skips this
 *    entirely -- the main process never sends the request.
 *  - after any MCP write lands, the tag index / file tree are refreshed
 *    (there is no file watcher, ADR-0018).
 *
 * Instantiated once from `App`; the subscriptions live for the app's
 * lifetime, so there is no teardown.
 */
@Injectable({ providedIn: 'root' })
export class McpBridgeService {
  private readonly confirmation = inject(ConfirmationService);
  private readonly taskList = inject(TaskService);
  private readonly vault = inject(VaultService);

  private started = false;

  start(): void {
    if (this.started || typeof window === 'undefined' || !window.dreyApi) {
      return;
    }
    this.started = true;

    window.dreyApi.onMcpWriteRequest?.((request) => void this.confirm(request));
    window.dreyApi.onVaultChanged?.(() => {
            void this.taskList.refresh();
      void this.vault.refresh();
    });
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
