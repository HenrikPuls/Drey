/**
 * The chat engine (ADR-0048): the ask flow against a chat note — the
 * bug-10(b) resolution. The note IS the conversation's source of truth:
 * every turn is appended before/after the call, a follow-up replays the
 * FULL persisted history (tool calls/results as real message pairs,
 * applied edits with their document), and only a provider-side session
 * (claude-code `--resume`) skips the replay. The old sidecar thread and
 * its ~12-message cap are gone for conversations.
 *
 * Failure semantics: a failed or cancelled generation truncates back the
 * just-appended user turn, so the note only ever shows completed
 * exchanges (the renderer keeps the question text for a re-send). A
 * resumed provider session that has gone stale gets ONE full-replay
 * retry before the failure surfaces.
 */
import type {
  ChatAttachment,
  ChatMessage,
  LlmChatResult,
  ToolCallEvent,
  ToolSpec,
} from '../../../shared/llm';
import { pickPreviewStyle } from '../../../shared/text-diff';
import { formatDateTime } from '../../../shared/timestamp';
import type { SdkTaskRecord } from '../../../shared/plugin-api';
import type { AppConfig } from '../../../shared/app-config';
import type { LlmCapabilities } from '../../../shared/llm';
import type { AskRequest, AssistantOutcome } from '../shared/ask';
import { quoteSelection } from '../shared/ask.js';
import { extractDocumentFence } from '../shared/document-fence';
import {
  ChatContextStatus,
  ChatNoteAttachment,
  ChatNoteTurn,
  ChatToolEntry,
  EDIT_PROPOSAL_MARKER,
  toolEntriesFromTrace,
} from '../shared/chat-note.js';
import { buildReplayMessages } from '../shared/chat-replay.js';
import {
  buildVaultContextBlock,
  contextCitations,
  resolveTargetVaultIds,
  type ActiveVaultScope,
  type RetrievedSection,
  type RetrievalOutcome,
} from '../shared/semantic.js';
import { ChatStore } from './chat-store';
import {
  TITLE_SYSTEM,
  buildAskUserMessage,
  buildTitleUserMessage,
  editCatchUpLine,
  sanitizeChatTitle,
} from './ask-prompts';
import { buildSystemPrompt } from './system-prompt';
import type { TemplateTools } from './template-tools';
import type { VaultExploreTools } from './vault-explore-tools';
import {
  TASKS_LIST_TOOL_NAME,
  matchTasksInAnswer,
  refineTasksEntries,
} from './tasks-tool.js';
import { LIVE_EDIT_TOOL_SPECS, createLiveEditSession } from './live-edit';
import { isAbort, normalizeDoc } from './action-engine';

/** One completion call with the engine's needs; abort via `taskId` (ADR-0014). */
export type ChatFn = (
  messages: readonly ChatMessage[],
  options?: {
    taskId?: string;
    vaultTools?: boolean;
    /** ADR-0069: the ask's resolved target vaults — the host filters out-of-scope vault READ tools. */
    vaultToolsScope?: readonly string[];
    /** web_fetch + the user's MCP servers (SDK 1.15, ADR-0063). */
    externalTools?: boolean;
    sessionRef?: string;
    attachments?: ChatAttachment[];
    onDelta?: (text: string) => void;
    /** The plugin's own tool specs (ADR-0049), merged into the call's tool set. */
    tools?: readonly ToolSpec[];
    /** Runs one plugin tool call; resolved text is the tool result. */
    onToolCall?: (name: string, argsJson: string) => Promise<string>;
    /** Round budget override (absent: the user's `tools.maxRounds`). */
    maxToolRounds?: number;
    /** Progress of the tool loop, one `start` and one `end` per call. */
    onToolEvent?: (event: ToolCallEvent) => void;
  },
) => Promise<LlmChatResult>;

export interface ChatEnginePorts {
  /**
   * Vault text read for attachment re-hydration; `null` = missing/unreadable.
   * The chat note lives in the vault that was active at ask time, but an
   * attachment may belong to a chip-scoped vault — `fallbackVaultIds` (the
   * ask's resolved targets) are tried in order when the default read misses.
   */
  readVaultText(path: string, fallbackVaultIds?: readonly string[]): Promise<string | null>;
  /**
   * The registered vaults (ADR-0051) with their active flag: the tools
   * note's vault list AND the ask's scope resolution (ADR-0069) read it.
   */
  listVaults(): Promise<readonly { id: string; name: string; active: boolean }[]>;
  resolveAssetPath(path: string): string | null;
  readAssetBase64(absPath: string): Promise<string | null>;
  /** Delta forwarding to the panel (the plugin's own `chat:delta` event). */
  onDelta(taskId: string, text: string): void;
  /**
   * One live-edit working-copy push (ADR-0049): fires after each mutating
   * doc-tool call; the renderer applies it to the open tab (`setBuffer`).
   */
  onLiveEdit(path: string, content: string): void;
  /** One step of the running tool loop, forwarded to the panel (`chat:toolEvent`). */
  onToolEvent(taskId: string, event: ToolCallEvent): void;
  /**
   * Semantic vault retrieval for one question (ADR-0055): the outcome —
   * hits with their fresh text, best first, plus WHY there are none
   * (feature off / floor too high / a custom selection with no registered
   * vault left). Only called when the ask turned the Vault chip on; hard
   * failures throw, the caller catches and degrades to no context.
   */
  retrieveContext(
    question: string,
    scope: ActiveVaultScope,
    vaultIds: readonly string[],
  ): Promise<RetrievalOutcome>;
  /**
   * The ADR-0069 explore tools for one ask turn (`vault_overview` /
   * `vault_find` / `vault_section`), closed over the turn's scope. They
   * ride a chip-on ask whenever the provider runs a tool loop — semantic
   * retrieval backs them when enabled, otherwise they degrade to fresh
   * filesystem scans (ADR-0069 later change). `null` = no tools this turn.
   */
  exploreTools(
    scope: ActiveVaultScope,
    vaultIds: readonly string[],
  ): VaultExploreTools | null;
  /**
   * The `tasks_list` tool for NON-live asks (SDK 1.11): the spec rides the
   * call's tool set and `run` executes one call against the base task
   * index; `query` reads the index directly (the post-hoc block). `null` =
   * no task provider registered — the tool stays unattached and the
   * prompts don't mention it.
   */
  tasksTool(): {
    spec: ToolSpec;
    run(argsJson: string): Promise<string>;
    query(opts?: {
      includeDone?: boolean;
      status?: 'open' | 'done' | 'all';
      vaultId?: string;
      sort?: 'file' | 'due' | 'priority' | 'importance' | 'completed';
    }): Promise<readonly SdkTaskRecord[]>;
  } | null;
  /**
   * The template_* tools for NON-live asks (SDK 1.14): list/read/write/
   * delete over the vault's configured template folder. Gated by the
   * `tools.templates` group; its write rule defaults to unconfirmed
   * (ADR-0011 later-change — structural, low-risk content; deletes go to
   * the recycle bin).
   */
  templateTools(): TemplateTools | null;
}

export interface ChatAskResult {
  chatPath: string;
  outcome: AssistantOutcome;
  /** How many vault sections were retrieved for this turn (0 when off). */
  contextCount: number;
  /** Set when retrieval was requested but failed — the panel shows it quiet. */
  contextError?: string;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** A live turn works hunk by hunk: it never gets fewer rounds than this. */
const LIVE_EDIT_MIN_ROUNDS = 16;

const LIVE_EDIT_NEEDS_TOOLS =
  'Live edit is unavailable: the model or its endpoint does not accept tools.';

/** The answer of a turn whose tools ran but whose model never said anything. */
const NO_ANSWER_AFTER_TOOLS =
  'The model used tools but gave no answer. What it did is listed below — ask again, or rephrase the question.';

/** A reply's text with every fenced block dropped (the edit guard's answer). */
function proseOutsideFences(reply: string): string {
  const kept: string[] = [];
  let fence: number | null = null;
  for (const line of reply.replace(/\r\n/g, '\n').split('\n')) {
    const ticks = /^(`{3,})/.exec(line)?.[1].length ?? 0;
    if (fence === null) {
      if (ticks > 0) {
        fence = ticks;
      } else {
        kept.push(line);
      }
    } else if (ticks >= fence && /^`+\s*$/.test(line)) {
      fence = null;
    }
  }
  return kept.join('\n').trim();
}

export class ChatEngine {
  constructor(
    private readonly store: ChatStore,
    private readonly getConfig: () => AppConfig,
    private readonly chat: ChatFn,
    private readonly capabilities: () => LlmCapabilities,
    private readonly ports: ChatEnginePorts,
  ) {}

  /**
   * The model (per provider and endpoint) whose endpoint refused a request
   * because tools were attached. Kept for the session: every further ask
   * to it goes out without tools and with a prompt that names none,
   * instead of paying for a refused request each time. Changing the
   * model, the provider or the endpoint asks afresh.
   */
  private refusedToolsKey: string | null = null;

  private static toolsKey(config: AppConfig): string {
    return [config.llm.provider, config.llm.baseUrl, config.llm.model].join(' | ');
  }

  private toolsRefused(config: AppConfig): boolean {
    return this.refusedToolsKey === ChatEngine.toolsKey(config);
  }

  private rememberToolsRefused(config: AppConfig): void {
    this.refusedToolsKey = ChatEngine.toolsKey(config);
  }

  async ask(request: AskRequest, taskId?: string): Promise<ChatAskResult> {
    const config = this.getConfig();
    if (!config.llm.enabled) {
      throw new Error('LLM features are disabled.');
    }
    // Live edit (ADR-0049) needs the provider's tool loop. Checked BEFORE
    // anything is persisted — a later throw would leave a dangling user
    // turn in the chat note.
    if (request.liveEdit && !this.capabilities().tools) {
      throw new Error('Live edit is unavailable: the active provider has no tool support.');
    }
    if (request.liveEdit && this.toolsRefused(config)) {
      throw new Error(LIVE_EDIT_NEEDS_TOOLS);
    }

    // 1 · The chat note: continue the given one, or create one titled by
    // the first question.
    let chatPath = request.chatPath;
    let created = false;
    if (chatPath === null) {
      const fresh = await this.store.create(
        new Date(),
        request.question,
        config.llm.provider,
        config.llm.model,
        request.noteKey,
      );
      chatPath = fresh.path;
      await this.store.save(fresh.path, fresh.content);
      created = true;
    }
    const view = await this.store.read(chatPath);

    // 2 · The user turn (question + attachment PATHS; bodies ride the
    // message only) is persisted BEFORE the call — a crash leaves a
    // dangling question, which the replay pops.
    const attachments: ChatNoteAttachment[] = [
      ...(request.note !== null ? [{ kind: 'note' as const, path: request.note.path }] : []),
      ...request.extraFiles.map((file) => ({ kind: 'note' as const, path: file.path })),
      ...request.images.map((path) => ({ kind: 'image' as const, path, alt: '' })),
    ];
    const userTurnIndex = view.turns.length;
    await this.store.appendTurn(chatPath, {
      role: 'user',
      at: formatDateTime(new Date()),
      meta: {},
      text:
        request.selection !== undefined
          ? quoteSelection(request.selection, request.question)
          : request.question,
      attachments,
      tool: [],
      context: [],
      contextStatus: null,
      start: 0,
    });

    // 3 · Session-vs-replay: a provider-side session continues with just
    // the new turn; everything else full-replays from the note.
    const caps = this.capabilities();
    const resume =
      !created &&
      caps.sessions &&
      view.frontmatter.session !== null &&
      view.frontmatter.provider === config.llm.provider;

    // The tool groups (ADR-0063): one switch each, read per ask.
    const groups = config.tools;
    const toolsOn = groups.vault.enabled;
    // Live branch (ADR-0049): the note IS the edit target, edited through
    // the doc tools over a main-side working copy seeded from the live
    // buffer. `note !== null` is guaranteed by the payload validation for a
    // liveEdit ask; the null-narrowing keeps TS happy.
    const liveSession =
      request.liveEdit && request.note !== null
        ? createLiveEditSession(request.note.path, request.note.body)
        : null;
    const live = liveSession !== null;
    const answerOnly = request.note === null;
    // The Vault chip's scope (ADR-0055/0069), resolved from the REGISTRY —
    // independent of retrieval. This is the enforcement floor: even a
    // disabled or failed retrieval arms the host filter below, so the base
    // tools' active-vault default can never leak an out-of-scope vault
    // into the answer. A live-edit turn ignores the scope entirely (the
    // document rides in full).
    const scope = request.vaultScope;
    const scopeOn = scope !== 'off' && !live;
    const vaults = await this.ports.listVaults();
    const activeVault = vaults.find((vault) => vault.active) ?? null;
    const targets =
      scope !== 'off' && !live ? resolveTargetVaultIds(vaults, scope, request.vaultIds) : [];
    const activeInScope = !scopeOn || activeVault === null || targets.includes(activeVault.id);
    // Semantic vault retrieval (ADR-0055): only for a plain ask turn — a
    // live-edit turn already carries the whole document + tool loop, so the
    // scope is ignored there. Failure degrades to no context, but the
    // REASON persists on the turn (contextStatus) so the panel can show
    // why nothing came back instead of staying silent.
    let contextHits: readonly RetrievedSection[] = [];
    let contextStatus: ChatContextStatus | null = null;
    let contextError: string | undefined;
    if (scopeOn) {
      try {
        const outcome = await this.ports.retrieveContext(
          request.question,
          scope,
          request.vaultIds,
        );
        contextHits = outcome.hits;
        if (!outcome.enabled) {
          contextStatus = { kind: 'disabled' };
        } else if (outcome.noTargets === true) {
          contextStatus = { kind: 'unregistered' };
        } else if (outcome.hits.length === 0) {
          contextStatus = { kind: 'empty', floor: outcome.minScore };
        }
      } catch (err) {
        contextError = err instanceof Error ? err.message : String(err);
        contextStatus = { kind: 'error', message: contextError };
        contextHits = [];
      }
    }
    // What rides this call (ADR-0071). The prompt is built from exactly
    // these, so it never names a tool the model does not get: a provider
    // without a tool loop gets none, and so does a model whose endpoint
    // refused the tools on an earlier ask of this session.
    const canCall = caps.tools && !this.toolsRefused(config);
    // The agentic half (ADR-0069): with the chip on and a tool-capable
    // provider, the model can scan the scoped vaults itself — even when
    // the baseline retrieval above came back empty or errored. When
    // semantic retrieval is disabled the tools degrade to fresh filesystem
    // scans (ADR-0069 later change); they never vanish, so a scoped ask
    // always keeps its in-scope lookups.
    const explore = scopeOn && canCall ? this.ports.exploreTools(scope, request.vaultIds) : null;
    // When the scope excludes the active vault the host drops
    // vault_search/vault_read (their default target is the active vault).
    const readToolsDropped = scopeOn && targets.length > 0 && !activeInScope;
    // External tools (ADR-0063): web_fetch and the user's MCP servers.
    // Never on a live-edit turn, and only where the provider runs a tool
    // loop at all -- otherwise the note would promise tools that are not
    // there.
    const externalOn =
      !live &&
      canCall &&
      (groups.webFetch.enabled || groups.servers.some((server) => server.enabled));
    // The tasks tool rides every non-live ask when a task provider exists
    // (SDK 1.11) and its group is on — and the scope does not exclude the
    // active vault (its index reads ONLY the active vault, so a scoped ask
    // must not attach it: its results would masquerade as an answer about
    // the scoped vaults).
    const tasksTool =
      live || !groups.tasks.enabled || !activeInScope ? null : this.ports.tasksTool();
    // The template tools ride every non-live ask too (SDK 1.14) while
    // their group is on; whether a write asks first is the group's rule.
    // Same scope rule as the tasks tool: they read the active vault only.
    const templateTools =
      live || !groups.templates.enabled || !activeInScope ? null : this.ports.templateTools();
    const contextBlock = contextHits.length > 0 ? buildVaultContextBlock(contextHits) : null;
    const promptMode = live ? 'live' : answerOnly ? 'answer' : 'ask';
    // `withTools: false` is the same question for a model that turned out
    // to take no tools: nothing attached, nothing promised.
    const systemContent = (withTools: boolean): string =>
      buildSystemPrompt({
        mode: promptMode,
        tools: withTools
          ? {
              ...(toolsOn ? { vault: { read: !readToolsDropped, write: groups.vault.write } } : {}),
              ...(explore !== null ? { explore: true } : {}),
              ...(tasksTool !== null ? { tasks: true } : {}),
              ...(templateTools !== null ? { templates: { write: groups.templates.write } } : {}),
              ...(externalOn ? { external: true } : {}),
            }
          : {},
        vaults,
        scopeVaultIds: scopeOn && targets.length > 0 ? targets : null,
        contextBlock,
        now: new Date(),
      });
    const catchUp = resume ? this.catchUpLine(view) : '';
    const userBody = buildAskUserMessage(request);
    const questionMessage: ChatMessage = {
      role: 'user',
      content: catchUp === '' ? userBody : `${catchUp}\n\n${userBody}`,
    };

    const buildMessages = async (
      useSession: boolean,
      withTools: boolean,
    ): Promise<ChatMessage[]> => {
      const baseMessages: ChatMessage[] = [{ role: 'system', content: systemContent(withTools) }];
      if (useSession) {
        return [...baseMessages, questionMessage];
      }
      const replay = await buildReplayMessages(view.turns, (path) =>
        this.ports.readVaultText(path, targets),
      );
      return [...baseMessages, ...replay.messages, questionMessage];
    };

    const imageAttachments =
      caps.imageAttachments && request.images.length > 0
        ? await this.readImageAttachments(request.images)
        : undefined;
    const options = (useSession: boolean, withTools: boolean) => ({
      taskId,
      ...(withTools && toolsOn ? { vaultTools: true } : {}),
      // Armed from the REGISTRY-resolved targets (not the retrieval's), so
      // the host filter holds even when retrieval is off or failed.
      ...(targets.length > 0 ? { vaultToolsScope: targets } : {}),
      ...(withTools && externalOn ? { externalTools: true } : {}),
      // The round budget is the user's (`tools.maxRounds`, applied by the
      // host); a live turn works hunk by hunk and never gets less than
      // its old allowance.
      ...(!withTools
        ? {}
        : liveSession !== null
          ? {
              tools: LIVE_EDIT_TOOL_SPECS,
              maxToolRounds: Math.max(groups.maxRounds, LIVE_EDIT_MIN_ROUNDS),
              onToolCall: (name: string, argsJson: string) =>
                liveSession.runTool(name, argsJson).then((run) => {
                  if (run.mutated) {
                    this.ports.onLiveEdit(liveSession.path, liveSession.work);
                  }
                  return run.text;
                }),
            }
          : explore !== null || tasksTool !== null || templateTools !== null
            ? {
                tools: [
                  ...(explore !== null ? explore.specs : []),
                  ...(templateTools !== null ? templateTools.specs : []),
                  ...(tasksTool !== null ? [tasksTool.spec] : []),
                ],
                onToolCall: (name: string, argsJson: string) => {
                  if (explore !== null && explore.names.has(name)) {
                    return explore.run(name, argsJson);
                  }
                  if (templateTools !== null && templateTools.names.has(name)) {
                    return templateTools.run(name, argsJson);
                  }
                  return tasksTool !== null && name === tasksTool.spec.name
                    ? tasksTool.run(argsJson)
                    : Promise.resolve(`Error: there is no tool "${name}" in this call.`);
                },
              }
            : {}),
      ...(withTools && taskId !== undefined
        ? { onToolEvent: (event: ToolCallEvent) => this.ports.onToolEvent(taskId, event) }
        : {}),
      ...(useSession && view.frontmatter.session !== null
        ? { sessionRef: view.frontmatter.session }
        : {}),
      ...(imageAttachments !== undefined && imageAttachments.length > 0
        ? { attachments: imageAttachments }
        : {}),
      ...(taskId !== undefined
        ? { onDelta: (text: string) => this.ports.onDelta(taskId, text) }
        : {}),
    });

    // 4 · One call (one full-replay retry when a resumed session went stale).
    const startedAt = Date.now();
    const callOnce = async (withTools: boolean): Promise<LlmChatResult> => {
      try {
        return await this.chat(await buildMessages(resume, withTools), options(resume, withTools));
      } catch (err) {
        if (resume && !isAbort(err)) {
          return this.chat(await buildMessages(false, withTools), options(false, withTools));
        }
        throw err;
      }
    };
    let result: LlmChatResult;
    try {
      result = await callOnce(canCall);
      // The endpoint refused the tools and answered without them — to a
      // prompt that described them. Ask again with a prompt that fits, and
      // remember it for this model so the next ask does not pay twice.
      if (result.toolsDropped === true) {
        this.rememberToolsRefused(config);
        if (liveSession !== null) {
          throw new Error(LIVE_EDIT_NEEDS_TOOLS);
        }
        result = await callOnce(false);
      }
    } catch (err) {
      await this.store.truncateFrom(chatPath, userTurnIndex);
      throw err;
    }
    const durationMs = Date.now() - startedAt;

    // A tool loop can end without the model ever speaking, even after the
    // loop asked once more for an answer. For a live-edit turn that is
    // fine — the outcome names what was applied. Where tools ran, the turn
    // is kept with what they did (a write may already be on disk — the
    // trace must not vanish with it) under a line that says so. Only a
    // reply with nothing at all fails like any other generation.
    if (
      liveSession === null &&
      result.text.trim() === '' &&
      (result.toolTrace?.length ?? 0) > 0
    ) {
      result = { ...result, text: NO_ANSWER_AFTER_TOOLS };
    }
    if (liveSession === null && result.text.trim() === '') {
      await this.store.truncateFrom(chatPath, userTurnIndex);
      throw new Error('The model returned no message content.');
    }

    const modelCalledTasks = (result.toolTrace ?? []).some(
      (message) =>
        message.role === 'assistant' &&
        message.tool_calls?.some((call) => call.function.name === TASKS_LIST_TOOL_NAME),
    );

    // 5 · The reply: a live turn's changes are already applied — the
    // model's text is the summary (the providers deliver an empty text
    // when the round cap hit mid-loop, so a fallback names what happened).
    // Otherwise an answer to display, or an edit to confirm (the outcome —
    // applied document or discarded marker — is appended to the turn's
    // fence by `chat:appendEdit` after the user's decision).
    let outcome: AssistantOutcome;
    if (liveSession !== null) {
      const fallback =
        liveSession.editCount > 0
          ? `Applied ${liveSession.editCount} edit(s) to ${liveSession.path}.`
          : 'No changes were needed.';
      outcome = {
        kind: 'liveEdit',
        path: liveSession.path,
        applied: liveSession.editCount,
        text: result.text.trim() || fallback,
      };
    } else {
      // ADR-0053: a change arrives as a `document` fence; a question (and
      // any reply without a usable fence — a prose decline, a truncated
      // document) degrades to a plain answer instead of a raw-JSON card.
      const fence = extractDocumentFence(result.text);
      const after = fence !== null ? normalizeDoc(fence.document) : null;
      // The edit guard (57d): a fence is only a change proposal when it
      // actually changes the document AND the turn was not a task lookup —
      // a model that answers "yes, do that" by wrapping the looked-up list
      // (or the untouched note) in a document fence asked a question, it
      // did not order an edit. The prose around the fence is the answer.
      if (
        request.note !== null &&
        after !== null &&
        after !== normalizeDoc(request.note.body) &&
        !modelCalledTasks
      ) {
        const body = request.note.body;
        outcome = {
          kind: 'edit',
          before: body,
          after,
          previewStyle: pickPreviewStyle(body, after),
          summary: request.question.trim(),
        };
      } else if (request.note !== null && after !== null) {
        outcome = {
          kind: 'answer',
          text:
            proseOutsideFences(result.text) ||
            (modelCalledTasks ? 'Here are the tasks.' : 'No changes were needed.'),
        };
      } else {
        outcome = { kind: 'answer', text: result.text.trim() };
      }
    }
    // What the user reads — the task matching below anchors to it, never
    // to a rejected fence's document text.
    const answerText = outcome.kind === 'edit' ? result.text : outcome.text;

    // 5b · The post-hoc task block (57b/57c): when the answer talks about
    // tasks — matched against the live index by word overlap, no question
    // keywords, no model discretion — the engine attaches a synthetic
    // `tasks_list` pair carrying the MATCHED subset (importance order).
    // The block is therefore scoped to what the answer discusses: a
    // "tasks of Henrik" question yields Henrik's tasks even when the
    // model never called the tool. A model call is refined the same way
    // (see refineTasksEntries): an unfiltered call's result is trimmed to
    // the answer's subset. Best-effort overall: an index failure never
    // fails the ask.
    const posthocEntries: ChatToolEntry[] = [];
    let toolEntries = toolEntriesFromTrace(result.toolTrace);
    if (tasksTool !== null && answerText.trim() !== '') {
      toolEntries = refineTasksEntries(toolEntries, answerText);
      if (!modelCalledTasks) {
        try {
          // Open tasks first; an answer about finished work (57d) falls
          // back to the completed ones, newest first — never a mixed list.
          const open = await tasksTool.query({ includeDone: false, sort: 'importance' });
          let matched = matchTasksInAnswer(answerText, open);
          if (matched.length === 0) {
            const done = await tasksTool.query({ status: 'done', sort: 'completed' });
            matched = matchTasksInAnswer(answerText, done);
          }
          if (matched.length > 0) {
            const id = `tasks-posthoc-${startedAt}`;
            posthocEntries.push(
              {
                kind: 'call',
                id,
                name: TASKS_LIST_TOOL_NAME,
                arguments: '{"posthoc":true}',
              },
              {
                kind: 'result',
                id,
                content: matched.map((task) => JSON.stringify(task)).join('\n'),
              },
            );
          }
        } catch {
          // Best-effort: the answer stands without the block.
        }
      }
    }

    // 6 · The assistant turn: text, meta, and the tool trace as drey-tool
    // entries — this is what makes the NEXT turn able to replay the loop.
    const assistantTurn: ChatNoteTurn = {
      role: 'assistant',
      at: formatDateTime(new Date()),
      meta: {
        ...(config.llm.model ? { model: config.llm.model } : {}),
        durationMs,
      },
      text:
        outcome.kind === 'answer' || outcome.kind === 'liveEdit'
          ? outcome.text
          : request.note !== null
            ? `${EDIT_PROPOSAL_MARKER} \`${request.note.path}\`]`
            : '',
      attachments: [],
      tool: [...toolEntries, ...posthocEntries],
      context: contextCitations(contextHits),
      contextStatus,
      start: 0,
    };
    await this.store.appendTurn(chatPath, assistantTurn, {
      ...(config.llm.model ? { model: config.llm.model } : {}),
      ...(result.sessionRef !== undefined ? { session: result.sessionRef } : {}),
    });
    // A live turn that changed something persists the applied document as
    // the turn's `edit` entry (applied: true) — the next replay then shows
    // the model its own result, same as a confirmed proposal.
    if (liveSession !== null && liveSession.editCount > 0) {
      await this.store.appendEditOutcome(chatPath, {
        path: liveSession.path,
        applied: true,
        after: liveSession.work,
      });
    }

    // 7 · A brand-new chat gets its TITLE from the model (57e) — the first
    // question was only the placeholder. Fire-and-forget: the ask result
    // returns immediately, the announced title write lands a moment later
    // and the picker/head label pick it up through the change round. Any
    // failure keeps the question-derived title.
    if (created) {
      const answerText =
        outcome.kind === 'answer' || outcome.kind === 'liveEdit' ? outcome.text : '';
      void this.generateTitle(chatPath, request.question, answerText);
    }

    return {
      chatPath,
      outcome,
      contextCount: contextHits.length,
      ...(contextError !== undefined ? { contextError } : {}),
    };
  }

  /**
   * The naming call (57e): same model, plain messages, no tools, no
   * history — question plus a short answer snippet. Never throws; an
   * unusable reply leaves the placeholder title as-is.
   */
  private async generateTitle(chatPath: string, question: string, answer: string): Promise<void> {
    try {
      const result = await this.chat(
        [
          { role: 'system', content: TITLE_SYSTEM },
          { role: 'user', content: buildTitleUserMessage(question, answer) },
        ],
      );
      const title = sanitizeChatTitle(result.text);
      if (title !== null) {
        await this.store.setTitle(chatPath, title);
      }
    } catch {
      // The question title stands.
    }
  }

  /** For a resumed session: the confirm result it never saw (one line). */
  private catchUpLine(view: { turns: ChatNoteTurn[] }): string {
    for (let i = view.turns.length - 1; i >= 0; i--) {
      const turn = view.turns[i];
      if (turn.role !== 'assistant') {
        break;
      }
      const edit = [...turn.tool].reverse().find((entry) => entry.kind === 'edit');
      if (edit && edit.kind === 'edit') {
        return editCatchUpLine(edit.path, edit.applied);
      }
    }
    return '';
  }

  /** Vault images → base64 attachments; missing/unreadable ones are skipped. */
  private async readImageAttachments(paths: readonly string[]): Promise<ChatAttachment[]> {
    const out: ChatAttachment[] = [];
    for (const path of paths) {
      const abs = this.ports.resolveAssetPath(path);
      if (abs === null) {
        continue;
      }
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES[ext];
      if (mediaType === undefined) {
        continue;
      }
      const base64 = await this.ports.readAssetBase64(abs);
      if (base64 === null) {
        continue;
      }
      out.push({ kind: 'image', mediaType, base64 });
    }
    return out;
  }
}
