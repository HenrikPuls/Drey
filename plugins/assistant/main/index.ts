import type {
  ActionContext,
  ActionOutcome,
  MainPluginContext,
  MainPluginModule,
  NoteSavedEvent,
  SaveHookResult,
} from '../../../shared/plugin-api';
import { parseAskPayload } from '../shared/ask.js';
import {
  extensionOf,
  externalFileKind,
  stagedAttachmentsDir,
  uniqueStagedName,
} from '../shared/stage.js';
import { ActionEngine, type ChatFn } from './action-engine';
import { ChatEngine } from './chat-engine';
import { ChatStore } from './chat-store';
import { createSemanticService, type SemanticService } from './semantic/service';
import { readFile } from 'node:fs/promises';
import { dialog, app } from 'electron';
import * as path from 'node:path';

/** `…/app.asar/…` → `…/app.asar.unpacked/…` (worker + glue must be real files). */
function unpackedPath(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

/** Module-level so `deactivate` can stop the worker + flush the indexes. */
let disposeSemantic: (() => void) | null = null;

/**
 * The Assistant plugin's main entry (ADR-0044 stage 7): the on-save Actions
 * save hook, the action engine behind the panel's manual actions, and the
 * chat engine + chat-note store behind the chat-first panel (ADR-0048).
 */
const plugin: MainPluginModule = {
  activate(ctx: MainPluginContext) {
    const engine = new ActionEngine(
      () => ctx.appConfig.get(),
      // The facade returns `LlmChatResult` (ADR-0047); the action engine's
      // `ChatFn` contract stays plain-string, so unwrap here.
      ((messages, options) =>
        ctx.llm
          .chat(messages, {
            taskId: options?.taskId,
            ...(options?.vaultTools !== undefined ? { vaultTools: options.vaultTools } : {}),
          })
          .then((result) => result.text)) satisfies ChatFn,
    );

    const chatStore = new ChatStore({
      read: (path) => ctx.vault.read(path),
      writeAnnounced: (path, content) => ctx.vault.writeAnnounced(path, content),
      list: () => ctx.vault.list(),
    });

    // -- semantic vault retrieval (ADR-0055) --------------------------------
    // One worker owns the transformers.js WASM pipeline; indexes persist
    // next to the plugin config and ride the save/vault registries like
    // the tags index. Retrieval happens in the ask flow (see the port).
    const semantic = createSemanticService(ctx, {
      dataDir: path.join(app.getPath('userData'), 'plugins', ctx.pluginId),
      workerPath: unpackedPath(path.join(__dirname, 'semantic', 'embed-worker.js')),
      modelCacheDir: path.join(app.getPath('userData'), 'models'),
    });
    disposeSemantic = () => semantic.dispose();
    void semantic
      .refreshConfig()
      .then(() => (semantic.isEnabled ? semantic.catchUpAll() : undefined))
      .catch((err: unknown) => ctx.log(err instanceof Error ? err.message : String(err), 'warn'));
    ctx.save.onNoteSaved((event) => {
      semantic.onSaved(event.vaultId, event.path, event.content);
    });
    ctx.vault.onChanged((event) => semantic.onVaultChanged(event));
    ctx.ipc.handle('semantic:status', () => semantic.status());
    ctx.ipc.handle('semantic:rebuild', (payload) => {
      const { vaultId } = (payload ?? {}) as { vaultId?: unknown };
      if (vaultId !== undefined && typeof vaultId !== 'string') {
        throw new Error('malformed semantic:rebuild payload');
      }
      return semantic.rebuild(vaultId as string | undefined);
    });
    ctx.ipc.handle('semantic:configChanged', () => semantic.onConfigChanged());

    const chatEngine = new ChatEngine(
      chatStore,
      () => ctx.appConfig.get(),
      (messages, options) =>
        ctx.llm.chat(messages, {
          taskId: options?.taskId,
          ...(options?.vaultTools !== undefined ? { vaultTools: options.vaultTools } : {}),
          ...(options?.tools !== undefined ? { tools: options.tools } : {}),
          ...(options?.onToolCall !== undefined ? { onToolCall: options.onToolCall } : {}),
          ...(options?.maxToolRounds !== undefined
            ? { maxToolRounds: options.maxToolRounds }
            : {}),
          ...(options?.sessionRef !== undefined ? { sessionRef: options.sessionRef } : {}),
          ...(options?.attachments !== undefined ? { attachments: options.attachments } : {}),
          ...(options?.onDelta !== undefined ? { onDelta: options.onDelta } : {}),
        }),
      () => ctx.llm.capabilities(),
      {
        readVaultText: async (path) => {
          try {
            return await ctx.vault.read(path);
          } catch {
            return null;
          }
        },
        listVaults: async () => {
          const vaults = await ctx.vault.listVaults();
          return vaults.map((vault) => ({ id: vault.id, name: vault.name }));
        },
        resolveAssetPath: (path) => ctx.vault.resolveAssetPath(path),
        readAssetBase64: async (abs) => {
          try {
            return Buffer.from(await readFile(abs)).toString('base64');
          } catch {
            return null;
          }
        },
        onDelta: (taskId, text) => ctx.ipc.emit('chat:delta', { taskId, text }),
        onLiveEdit: (path, content) => ctx.ipc.emit('chat:liveEdit', { path, content }),
        retrieveContext: (question, scope) => semantic.retrieve(question, scope),
      },
    );

    // -- the on-save Actions save hook -------------------------------------
    ctx.save.onNoteSaved(async (event) => runOnSaveActions(ctx, engine, event));

    // -- the panel's methods ------------------------------------------------
    ctx.ipc.handle('run', (payload) => {
      const { triggerId, context, taskId } = shape(payload) as {
        triggerId?: unknown;
        context?: unknown;
        taskId?: unknown;
      };
      if (typeof triggerId !== 'string' || typeof context !== 'object' || context === null) {
        throw new Error('malformed run payload');
      }
      return engine.run(
        triggerId,
        context as ActionContext,
        typeof taskId === 'string' ? taskId : undefined,
      );
    });

    ctx.ipc.handle('ask', (payload) => {
      // Validation lives in the shared contract (`shared/ask.ts`) so the
      // renderer's tests cover it; the bug-10 visible-failure rule came
      // with it. The engine persists + replays the chat note itself — no
      // `history` rides the wire any more.
      const { request, taskId } = parseAskPayload(payload);
      return chatEngine.ask(request, taskId);
    });

    // -- the chat-note store (ADR-0048) --------------------------------------
    ctx.ipc.handle('chat:list', () => chatStore.listChats());

    ctx.ipc.handle('chat:read', (payload) => {
      const { path } = shape(payload) as { path?: unknown };
      if (typeof path !== 'string') {
        throw new Error('malformed chat:read payload');
      }
      return chatStore.read(path);
    });

    ctx.ipc.handle('chat:appendEdit', (payload) => {
      const { path, applied, after } = shape(payload) as {
        path?: unknown;
        applied?: unknown;
        after?: unknown;
      };
      if (typeof path !== 'string' || typeof applied !== 'boolean') {
        throw new Error('malformed chat:appendEdit payload');
      }
      return chatStore.appendEditOutcome(path, {
        path,
        applied,
        ...(typeof after === 'string' ? { after } : {}),
      });
    });

    ctx.ipc.handle('chat:truncate', (payload) => {
      const { path, turnIndex } = shape(payload) as { path?: unknown; turnIndex?: unknown };
      if (typeof path !== 'string' || typeof turnIndex !== 'number') {
        throw new Error('malformed chat:truncate payload');
      }
      return chatStore.truncateFrom(path, turnIndex);
    });

    ctx.ipc.handle('chat:attachExternal', (payload) => {
      // Files NOT yet in the vault: a native multi-select dialog, then each
      // pick is staged into the vault (images hash-named via saveAsset,
      // text files copied name-preserving under the reference note's
      // attachments/) so the chat note's attachment links resolve and a
      // replay re-reads them like any other attachment (ADR-0048).
      const { referenceNote } = shape(payload) as { referenceNote?: unknown };
      if (typeof referenceNote !== 'string') {
        throw new Error('malformed chat:attachExternal payload');
      }
      return stageExternalFiles(ctx, referenceNote);
    });
  },

  deactivate() {
    disposeSemantic?.();
    disposeSemantic = null;
  },
};

/**
 * The on-save Actions (was `registerBaseSaveHooks` in the base app, before
 * that inline in `NoteManager`): gated on the LLM master switch,
 * non-confirm edits written back before the next trigger runs.
 */
async function runOnSaveActions(
  ctx: MainPluginContext,
  engine: ActionEngine,
  event: NoteSavedEvent,
): Promise<SaveHookResult | void> {
  if (!ctx.llm.enabled()) {
    return undefined;
  }
  const pendingActions: ActionOutcome[] = [];
  let current = event.content;
  let currentMs = event.modifiedMs;
  for (const action of engine.actionsForEvent('on-save')) {
    const outcome = await engine.run(action.triggerId, {
      path: event.path,
      body: current,
    });
    if (outcome.kind !== 'edit') {
      continue;
    }
    if (action.confirm) {
      pendingActions.push({ ...outcome, before: current });
    } else {
      current = outcome.after;
      currentMs = await ctx.vault.write(event.path, toDisk(current, event.eol));
    }
  }
  return current !== event.content
    ? {
        content: current,
        modifiedMs: currentMs,
        ...(pendingActions.length > 0 ? { pendingActions } : {}),
      }
    : { ...(pendingActions.length > 0 ? { pendingActions } : {}) };
}

function toDisk(text: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/** One staged external file: the vault path it landed on, and its chip kind. */
interface StagedFile {
  path: string;
  kind: 'file' | 'image';
}

/**
 * Native multi-select, then copy each pick into the vault: images through
 * the hash-named asset path (ADR-0024), text files name-preserving and
 * uniqued against the target folder (`report.md`, `report-2.md` — also
 * across one batch). Anything neither text nor image is reported as
 * skipped. Collisions and unreadable files skip instead of failing the
 * batch — the renderer surfaces them as a quiet notice.
 */
async function stageExternalFiles(
  ctx: MainPluginContext,
  referenceNote: string,
): Promise<{ staged: StagedFile[]; skipped: string[] }> {
  const win = ctx.app.getMainWindow();
  const extensions = [...STAGE_DIALOG_EXTENSIONS];
  const options = {
    title: 'Attach files to the chat',
    properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
    filters: [
      { name: 'Text and images', extensions },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const result =
    win !== null ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return { staged: [], skipped: [] };
  }

  const targetDir = stagedAttachmentsDir(referenceNote);
  const existing = new Set(
    (await ctx.vault.list())
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.relativePath),
  );
  const staged: StagedFile[] = [];
  const skipped: string[] = [];
  for (const absolute of result.filePaths) {
    const name = path.basename(absolute);
    const kind = externalFileKind(name);
    if (kind === null) {
      skipped.push(name);
      continue;
    }
    try {
      if (kind === 'image') {
        const bytes = await readFile(absolute);
        const assetPath = await ctx.vault.saveAsset(
          new Uint8Array(bytes),
          extensionOf(name),
          referenceNote,
        );
        staged.push({ path: assetPath, kind });
        existing.add(assetPath);
        continue;
      }
      const unique = uniqueStagedName(name, [...existing].map((p) => p.split('/').pop() ?? p));
      const target = `${targetDir}/${unique}`;
      await ctx.vault.writeAnnounced(target, await readFile(absolute, 'utf8'));
      staged.push({ path: target, kind });
      existing.add(target);
    } catch {
      skipped.push(name);
    }
  }
  return { staged, skipped };
}

/** The dialog filter union — staging itself routes per file via `externalFileKind`. */
const STAGE_DIALOG_EXTENSIONS = [
  ...'md markdown mdx txt csv json ts js py c h cpp cs xml yaml yml log'.split(' '),
  ...'png jpg jpeg webp gif'.split(' '),
];

function shape(payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}

export default plugin;
