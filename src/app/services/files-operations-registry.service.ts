import { Injectable } from '@angular/core';
import type {
  Unsubscribe,
  VaultFileOperation,
  VaultFileOperationOutcome,
  VaultFileOperationsHandler,
  VaultFileOperationVerdict,
} from '../../../shared/plugin-api/renderer';

/**
 * What the Files panel should do with an operation after consulting the
 * registered handlers (SDK 1.32). The `handle` case carries the bound
 * `perform` of the handler that claimed the operation, so the panel runs
 * exactly the taker that was consulted.
 */
export type FilesOperationDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'refuse'; readonly reason: string }
  | { readonly action: 'handle'; perform(): Promise<VaultFileOperationOutcome> };

/**
 * The Files-panel operation seam (SDK 1.32): plugins register one handler
 * for their vaults (`api.files.registerOperations`) and the panel consults
 * it before running any create/rename/move/copy/delete — a `refuse` veto
 * replaces the whole flow (dialogs included), a `handle` lets the plugin
 * perform the operation as a structured action.
 *
 * Consultation order is registration order; the first `refuse` wins (a
 * veto beats a takeover), then the first `handle`, `allow` otherwise.
 */
@Injectable({ providedIn: 'root' })
export class FilesOperationsRegistryService {
  /** pluginId -> handler; Map iteration order = consultation order. */
  private readonly handlers = new Map<string, VaultFileOperationsHandler>();

  register(pluginId: string, handler: VaultFileOperationsHandler): Unsubscribe {
    this.handlers.set(pluginId, handler);
    return () => {
      // A later registration replaced this plugin's slot — keep that one.
      if (this.handlers.get(pluginId) === handler) {
        this.handlers.delete(pluginId);
      }
    };
  }

  /** Drops one plugin's handler (deactivation, quarantine). */
  clear(pluginId: string): void {
    this.handlers.delete(pluginId);
  }

  /**
   * Asks every handler in registration order: the first `refuse` wins (a
   * veto beats a takeover), then the first `handle`, `allow` otherwise.
   * A throwing `check` counts as a refusal with its message — a broken
   * plugin must never let an operation it was asked about slip through
   * unexamined.
   */
  async check(operation: VaultFileOperation): Promise<FilesOperationDecision> {
    let taker: VaultFileOperationsHandler | null = null;
    for (const handler of this.handlers.values()) {
      const verdict = await this.safeCheck(handler, operation);
      if (verdict.action === 'refuse') {
        return { action: 'refuse', reason: verdict.reason };
      }
      if (verdict.action === 'handle' && taker === null) {
        taker = handler;
      }
    }
    if (taker === null) {
      return { action: 'allow' };
    }
    return { action: 'handle', perform: () => this.invoke(taker, operation) };
  }

  /**
   * Performs the operation with the handler that claims it via `check`;
   * resolves to a failed outcome when none does (or one refused). The
   * panel's takeover path goes through `check(...).perform()` so the
   * taker it showed the user is the taker that runs.
   */
  async perform(operation: VaultFileOperation): Promise<VaultFileOperationOutcome> {
    const decision = await this.check(operation);
    if (decision.action !== 'handle') {
      return {
        ok: false,
        error:
          decision.action === 'refuse'
            ? decision.reason
            : 'No plugin took over this operation.',
      };
    }
    return decision.perform();
  }

  private async safeCheck(
    handler: VaultFileOperationsHandler,
    operation: VaultFileOperation,
  ): Promise<VaultFileOperationVerdict> {
    try {
      return await handler.check(operation);
    } catch (error) {
      return { action: 'refuse', reason: errorMessage(error) };
    }
  }

  private async invoke(
    handler: VaultFileOperationsHandler,
    operation: VaultFileOperation,
  ): Promise<VaultFileOperationOutcome> {
    try {
      return await handler.perform(operation);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
