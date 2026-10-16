/**
 * The vault tool set (ADR-0021, recut in ADR-0071): one implementation
 * for the two callers — programs connected to Drey's MCP server
 * (`server.ts`) and the built-in assistant's tool loop (through the
 * host's `ctx.llm.chat`). The tools themselves live in `tools/`, one
 * concern per file; this class decides what a caller is offered and
 * routes a call.
 *
 *  - `vault_list`, `vault_search`, `vault_read` — read;
 *  - `vault_edit`, `vault_write`, `vault_move`, `vault_delete` — change;
 *  - `tasks_list` — the task index (offered to MCP clients here; the
 *    assistant attaches it itself).
 *
 * Every call carries what it may do (`VaultCallOptions`): the vaults in
 * scope, the write rule, and whether the app's own folders are off
 * limits. All file access goes through `VaultManager`, so its
 * vault-escape guard applies unchanged.
 */
import type { ToolSpec } from '../../shared/llm';
import { runTasksList } from '../../shared/tasks-list-tool';
import {
  READ_TOOLS,
  TASKS_LIST,
  VAULT_EDIT,
  VAULT_READ,
  VAULT_WRITE,
  WRITE_TOOLS,
} from './tools/defs';
import { vaultList } from './tools/list';
import { vaultRead } from './tools/read';
import { ToolScope } from './tools/scope';
import { vaultSearch } from './tools/search';
import {
  fail,
  McpToolDef,
  McpToolResult,
  ok,
  VaultCallOptions,
  VaultToolDeps,
  VaultWriteRule,
} from './tools/types';
import { vaultDelete, vaultEdit, vaultMove, vaultWrite, WriteContext } from './tools/write';

export type {
  ApproveAction,
  ConfirmWrite,
  McpTextContent,
  McpToolDef,
  McpToolResult,
  VaultCallOptions,
  VaultToolDeps,
  VaultWriteRule,
} from './tools/types';

export class VaultTools {
  constructor(private readonly deps: VaultToolDeps) {}

  /** The write rule of a call that names none: an MCP client follows `mcp.yolo`. */
  private rule(options: VaultCallOptions | undefined): VaultWriteRule {
    return options?.write ?? (this.deps.getConfig().mcp.yolo ? 'auto' : 'confirm');
  }

  /**
   * The tools a caller is offered: the changing tools only when the
   * caller may write at all. A call that carries files of its own (the
   * assistant's attached note) always gets the tools to read and change
   * a single file — and nothing else when no vault is in its scope.
   */
  list(options?: VaultCallOptions, include: { tasks: boolean } = { tasks: true }): McpToolDef[] {
    const scope = new ToolScope(this.deps.vault, options ?? {});
    const ownFiles = scope.files.length > 0;
    if (scope.inScope.length === 0 && ownFiles) {
      return [VAULT_READ, VAULT_EDIT, VAULT_WRITE];
    }
    const writing =
      this.rule(options) !== 'off' ? WRITE_TOOLS : ownFiles ? [VAULT_EDIT, VAULT_WRITE] : [];
    return [
      ...READ_TOOLS,
      ...writing,
      ...(include.tasks ? [TASKS_LIST] : []),
    ];
  }

  /**
   * The same tools as canonical `ToolSpec`s (ADR-0047) for the
   * assistant's tool loop — without `tasks_list`, which the assistant
   * attaches itself under its own group switch.
   */
  toolSpecs(options?: VaultCallOptions): ToolSpec[] {
    return this.list(options, { tasks: false }).map((def) => ({
      name: def.name,
      description: def.description,
      parameters: def.inputSchema,
    }));
  }

  /** Runs one tool by name. A failed call comes back as `isError` text the model can act on. */
  async call(
    name: string,
    args: Record<string, unknown>,
    options?: VaultCallOptions,
  ): Promise<McpToolResult> {
    const { deps } = this;
    const scope = new ToolScope(deps.vault, options ?? {});
    // Whether a change is allowed is decided per file, where it is made:
    // a file the call carries in its own scope is never refused.
    const write: WriteContext = {
      deps,
      scope,
      rule: this.rule(options),
      origin: options?.origin ?? 'mcp',
      ...(options?.onChange !== undefined ? { onChange: options.onChange } : {}),
    };
    try {
      switch (name) {
        case 'vault_list':
          return await vaultList(deps.vault, scope, args);
        case 'vault_search':
          return await vaultSearch(deps, scope, args);
        case 'vault_read':
          return await vaultRead(deps, scope, args);
        case 'vault_edit':
          return await vaultEdit(write, args);
        case 'vault_write':
          return await vaultWrite(write, args);
        case 'vault_move':
          return await vaultMove(write, args);
        case 'vault_delete':
          return await vaultDelete(write, args);
        case 'tasks_list': {
          const provider = deps.getTaskProvider();
          return provider === null
            ? fail('Error: tasks are unavailable — the Tasks plugin is switched off.')
            : ok(await runTasksList(provider, args));
        }
        default:
          return fail(`Error: there is no tool "${name}".`);
      }
    } catch (err) {
      return fail(`Error: ${name} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
