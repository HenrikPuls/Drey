/**
 * The builders behind a plugin's `MainPluginContext` (ADR-0044), one per
 * SDK namespace that is more than a pass-through: `ctx.vault` and
 * `ctx.llm`. Each takes only what it uses, so it can be built and tested
 * without a `PluginHost`. The namespaces that are a view on the host's own
 * registries (`app`, `save`, `search`, `tasks`, `ipc`, `config`) stay in
 * `PluginHost.buildContext`.
 */
import type { MainPluginContext, Unsubscribe, VaultChangeEvent } from '../../shared/plugin-api';
import type { VaultTools } from '../mcp';
import type { PluginHostDeps } from './plugin-host';

/** Remembers an `Unsubscribe` the context handed out, so deactivation can drain it. */
export type TrackDisposable = <T>(unsubscribe: T) => T;

/**
 * The ADR-0069 read-scope rule (pure, spec-covered): `vault_search` and
 * `vault_read` default to the ACTIVE vault, so a call whose declared scope
 * excludes it must not carry them — they would leak out-of-scope content.
 * Everything else passes; an absent scope or no active vault means the
 * pre-1.20 behaviour.
 */
export function vaultReadToolAllowed(
  name: string,
  scope: readonly string[] | undefined,
  activeVaultId: string | null,
): boolean {
  if (name !== 'vault_search' && name !== 'vault_read') {
    return true;
  }
  if (scope === undefined) {
    return true;
  }
  return activeVaultId !== null && scope.includes(activeVaultId);
}

/** Bridges one model tool call to the base `VaultTools`, flattening the result to text. */
export async function runVaultTool(
  vaultTools: VaultTools | undefined,
  name: string,
  argsJson: string,
  confirmWrites?: boolean,
): Promise<string> {
  if (!vaultTools) {
    return 'Vault tools are not available.';
  }
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}');
    if (parsed && typeof parsed === 'object') {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return `Could not parse arguments for ${name}: ${argsJson}`;
  }
  const result = await vaultTools.call(
    name,
    args,
    confirmWrites !== undefined ? { confirmWrites } : undefined,
  );
  return result.content.map((block) => block.text).join('\n');
}

/** `ctx.vault`: file IO in the vaults, with the plugin's id as the history origin. */
export function buildVaultContext(
  pluginId: string,
  deps: Pick<PluginHostDeps, 'vaultManager' | 'vaultAnnouncer' | 'confirmWrite'>,
  onChanged: (cb: (event: VaultChangeEvent) => void) => Unsubscribe,
): MainPluginContext['vault'] {
  const { vaultManager } = deps;
  return {
    listVaults: () => Promise.resolve(vaultManager.listVaults()),
    read: (p, opts) => vaultManager.readFile(p, opts?.vaultId).then((f) => f.content),
    write: (p, content, opts) =>
      vaultManager.writeFile(p, content, opts?.vaultId, { origin: pluginId }),
    // A write the tree/index/open tabs must see NOW (chat notes, a
    // plugin-generated note): same round an MCP write runs — per-file
    // index events + one scoped `vault:changed` push. A plain `write`
    // announces nothing (sidecars etc. don't want the churn), and with
    // the watcher off nothing else would fire for it.
    writeAnnounced: async (p, content, opts) => {
      const vaultId = vaultManager.resolveVaultId(opts?.vaultId);
      const modifiedMs = await vaultManager.writeFile(p, content, vaultId, { origin: pluginId });
      deps.vaultAnnouncer()?.announceExternal({ vaultId, changedPaths: [p], deletedPaths: [] });
      return modifiedMs;
    },
    // The app's own delete path (recycle bin first, milestone 52) plus
    // the same announcement round — a plugin delete looks exactly like
    // a Files-panel delete to tree and indexes.
    delete: async (p, opts) => {
      const vaultId = vaultManager.resolveVaultId(opts?.vaultId);
      const { trashed } = await vaultManager.deleteEntry(p, vaultId);
      deps.vaultAnnouncer()?.announceExternal({
        vaultId,
        changedPaths: [],
        deletedPaths: [p],
      });
      return trashed;
    },
    confirmWrite: (request) =>
      deps.confirmWrite?.({ ...request, mode: 'overwrite', origin: 'assistant' }) ??
      Promise.resolve(false),
    // A plugin rewrote the working tree itself (a git checkout / pull):
    // the same round the watcher would run, scoped when paths are known.
    announceChanges: (changes) => {
      const changedPaths = changes.changedPaths ?? [];
      const deletedPaths = changes.deletedPaths ?? [];
      if (changedPaths.length === 0 && deletedPaths.length === 0) {
        deps.vaultAnnouncer()?.announceFullRefresh(changes.vaultId);
        return;
      }
      const isNote = (p: string): boolean => p.toLowerCase().endsWith('.md');
      deps.vaultAnnouncer()?.announceExternal({
        vaultId: changes.vaultId,
        changedPaths: changedPaths.filter(isNote),
        deletedPaths: deletedPaths.filter(isNote),
        otherPaths: [...changedPaths, ...deletedPaths].filter((p) => !isNote(p)),
      });
    },
    saveAsset: (bytes, ext, noteRelPath, opts) =>
      vaultManager.saveAsset(bytes, ext, noteRelPath, opts?.vaultId),
    list: (opts) => vaultManager.listFiles(opts?.vaultId),
    listMarkdownFiles: (opts) => vaultManager.listMarkdownFiles(opts?.vaultId),
    resolveAssetPath: (p, opts) => vaultManager.resolveAssetPath(p, opts?.vaultId),
    onChanged,
    pickSavePath: (suggestedName, opts) => vaultManager.pickSavePath(suggestedName, opts?.vaultId),
  };
}

/** `ctx.llm`: the provider router, with the tool sets a call opts into merged in. */
export function buildLlmContext(
  deps: Pick<
    PluginHostDeps,
    | 'appConfig'
    | 'llm'
    | 'llmTasks'
    | 'tagSuggester'
    | 'llmDebug'
    | 'vaultManager'
    | 'vaultTools'
    | 'assistantToolbox'
  >,
  track: TrackDisposable,
): MainPluginContext['llm'] {
  const { appConfig, llm, llmTasks, tagSuggester, llmDebug } = deps;
  return {
    enabled: () => appConfig.get().llm.enabled,
    chat: (messages, options) =>
      llmTasks.run(options?.taskId, (signal) =>
        llm.chat([...messages], {
          temperature: options?.temperature,
          ...(options?.onDelta !== undefined ? { onDelta: options.onDelta } : {}),
          ...(options?.sessionRef !== undefined ? { sessionRef: options.sessionRef } : {}),
          ...(options?.attachments !== undefined ? { attachments: [...options.attachments] } : {}),
          // Tool sets merge (ADR-0049): the plugin's own tools first, the
          // vault set (when opted in) filtered to non-colliding names —
          // a plugin tool wins a name collision.
          ...(() => {
            const pluginTools = [...(options?.tools ?? [])];
            const pluginNames = new Set(pluginTools.map((tool) => tool.name));
            const groups = appConfig.get().tools;
            // tasks_list also sits in the vault set (for MCP clients);
            // towards the assistant it follows its own group switch.
            // ADR-0069: when the call carries a vault read scope that
            // excludes the active vault, `vault_search`/`vault_read`
            // drop out — they default to the active vault and would
            // leak out-of-scope content; the caller supplies scope-safe
            // plugin tools instead. `vault_write` is never filtered.
            const readScope = options?.vaultToolsScope;
            const readScopeAllows = (name: string): boolean =>
              vaultReadToolAllowed(name, readScope, deps.vaultManager.getActiveVaultId());
            const vaultSpecs =
              options?.vaultTools === true && deps.vaultTools !== undefined
                ? deps.vaultTools
                    .toolSpecs()
                    .filter((spec) => !pluginNames.has(spec.name))
                    .filter((spec) => groups.tasks.enabled || spec.name !== 'tasks_list')
                    .filter((spec) => readScopeAllows(spec.name))
                : [];
            const taken = new Set([...pluginNames, ...vaultSpecs.map((spec) => spec.name)]);
            const toolbox = deps.assistantToolbox;
            const externalSpecs =
              options?.externalTools === true && toolbox !== undefined
                ? toolbox.specs().filter((spec) => !taken.has(spec.name))
                : [];
            const externalNames = new Set(externalSpecs.map((spec) => spec.name));
            const merged = [...pluginTools, ...vaultSpecs, ...externalSpecs];
            return merged.length > 0
              ? {
                  tools: merged,
                  onToolCall: (name: string, argsJson: string) =>
                    pluginNames.has(name) && options?.onToolCall !== undefined
                      ? options.onToolCall(name, argsJson)
                      : externalNames.has(name) && toolbox !== undefined
                        ? toolbox.run(name, argsJson, signal)
                        : runVaultTool(
                            deps.vaultTools,
                            name,
                            argsJson,
                            groups.vault.write === 'confirm',
                          ),
                }
              : {};
          })(),
          ...(options?.maxToolRounds !== undefined ? { maxToolRounds: options.maxToolRounds } : {}),
          ...(options?.maxOutputTokens !== undefined
            ? { maxOutputTokens: options.maxOutputTokens }
            : {}),
          signal,
        }),
      ),
    capabilities: () => llm.capabilities(),
    // The vocabulary-based Autotag — a base surface (editor + Tags
    // plugin vocabulary) also reachable from plugins.
    suggestTags: (entryText, vocabulary, taskId) =>
      tagSuggester.suggest(entryText, [...vocabulary], taskId),
    onDebugEntry: (cb) => track(llmDebug.onEntry(cb)),
  };
}
