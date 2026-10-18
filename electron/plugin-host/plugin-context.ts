/**
 * The builders behind a plugin's `MainPluginContext` (ADR-0044), one per
 * SDK namespace that is more than a pass-through: `ctx.vault` and
 * `ctx.llm`. Each takes only what it uses, so it can be built and tested
 * without a `PluginHost`. The namespaces that are a view on the host's own
 * registries (`app`, `save`, `search`, `tasks`, `ipc`, `config`) stay in
 * `PluginHost.buildContext`.
 */
import type { MainPluginContext, Unsubscribe, VaultChangeEvent } from '../../shared/plugin-api';
import type { ActionsConfig } from '../../shared/app-config';
import { NO_VAULT, type VaultCallOptions, type VaultTools, type VaultWriteRule } from '../mcp';
import type { PluginHostDeps } from './plugin-host';

/** Remembers an `Unsubscribe` the context handed out, so deactivation can drain it. */
export type TrackDisposable = <T>(unsubscribe: T) => T;

/**
 * What a plugin call may do with the vault tools (ADR-0071): the vaults
 * the caller named are the scope of reading AND writing, the vault
 * group's rule decides whether it may write and whether it asks, and the
 * app's own folders stay out. `extra` carries the files that are in scope
 * by themselves (the attached note) and the caller's change listener.
 * Pure, spec-covered.
 */
export function assistantVaultOptions(
  scope: readonly string[] | undefined,
  write: VaultWriteRule,
  extra: Pick<VaultCallOptions, 'files' | 'onChange'> = {},
): VaultCallOptions {
  return {
    ...(scope !== undefined ? { scope } : {}),
    write,
    origin: 'assistant',
    protectAppFolders: true,
    ...(extra.files !== undefined && extra.files.length > 0 ? { files: extra.files } : {}),
    ...(extra.onChange !== undefined ? { onChange: extra.onChange } : {}),
  };
}

/**
 * Bridges one model tool call to the base `VaultTools`, flattening the
 * result to text. A failed call reads `Error: …` — the one convention the
 * tool loop and the model go by (ADR-0071).
 */
export async function runVaultTool(
  vaultTools: VaultTools | undefined,
  name: string,
  argsJson: string,
  callOptions?: VaultCallOptions,
): Promise<string> {
  if (!vaultTools) {
    return 'Error: the vault tools are not available.';
  }
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(argsJson || '{}');
    if (parsed && typeof parsed === 'object') {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return `Error: the arguments of ${name} are not valid JSON — send one JSON object.`;
  }
  const result = await vaultTools.call(name, args, callOptions);
  const text = result.content.map((block) => block.text).join('\n');
  return result.isError === true && !text.startsWith('Error:') ? `Error: ${text}` : text;
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
  readActions: () => Promise<ActionsConfig>,
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
            // The vault set as this call may use it (ADR-0071): the
            // caller's scope bounds reading and writing alike, the vault
            // group's rule decides about the changing tools. `tasks_list`
            // is not part of it — the assistant brings its own and leaves
            // it out on purpose where the task index would answer for
            // the wrong vault.
            const activeVaultId = deps.vaultManager.getActiveVaultId();
            const vaultOptions = assistantVaultOptions(
              options?.vaultToolsScope,
              groups.vault.write,
              {
                files: (options?.vaultToolsFiles ?? []).flatMap((file) => {
                  const vaultId =
                    file.vaultId === null ? NO_VAULT : (file.vaultId ?? activeVaultId);
                  return vaultId === null
                    ? []
                    : [{ vaultId, path: file.path, ...(file.live === true ? { live: true } : {}) }];
                }),
                ...(options?.onVaultChange !== undefined
                  ? { onChange: options.onVaultChange }
                  : {}),
              },
            );
            const vaultSpecs =
              options?.vaultTools === true && deps.vaultTools !== undefined
                ? deps.vaultTools
                    .toolSpecs(vaultOptions)
                    .filter((spec) => !pluginNames.has(spec.name))
                : [];
            const taken = new Set([...pluginNames, ...vaultSpecs.map((spec) => spec.name)]);
            const toolbox = deps.assistantToolbox;
            const externalSpecs =
              options?.externalTools === true && toolbox !== undefined
                ? toolbox.specs().filter((spec) => !taken.has(spec.name))
                : [];
            const externalNames = new Set(externalSpecs.map((spec) => spec.name));
            const vaultNames = new Set(vaultSpecs.map((spec) => spec.name));
            const merged = [...pluginTools, ...vaultSpecs, ...externalSpecs];
            return merged.length > 0
              ? {
                  tools: merged,
                  // Each name runs where it was offered from — and a name
                  // that was not offered runs nowhere (ADR-0071): a vault
                  // tool the scope or the group switch left out must not
                  // execute because the model asked for it anyway.
                  onToolCall: (name: string, argsJson: string): Promise<string> => {
                    if (pluginNames.has(name) && options?.onToolCall !== undefined) {
                      return options.onToolCall(name, argsJson);
                    }
                    if (externalNames.has(name) && toolbox !== undefined) {
                      return toolbox.run(name, argsJson, signal);
                    }
                    if (vaultNames.has(name)) {
                      return runVaultTool(deps.vaultTools, name, argsJson, vaultOptions);
                    }
                    return Promise.resolve(`Error: there is no tool "${name}" in this call.`);
                  },
                  maxToolRounds: options?.maxToolRounds ?? groups.maxRounds,
                  ...(options?.onToolEvent !== undefined
                    ? { onToolEvent: options.onToolEvent }
                    : {}),
                }
              : {};
          })(),
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
    // The stored built-in prompt (assistant plugin config; SDK 1.28) —
    // the read seam sibling plugins summarize/suggest through. `null`
    // when missing or blank, so the caller applies its shipped default.
    actionPrompt: async (builtin) => {
      const actions = await readActions();
      const template = actions.templates.find((entry) => entry.builtin === builtin);
      return template !== undefined && template.prompt.trim() !== '' ? template.prompt : null;
    },
    onDebugEntry: (cb) => track(llmDebug.onEntry(cb)),
  };
}
