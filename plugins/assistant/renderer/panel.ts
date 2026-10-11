/**
 * The assistant panel's DOM (ADR-0044 rule 2: plugin UI is plain DOM).
 * Chat-first since ADR-0048: a chat picker + "New chat" in the head, turn
 * cards rendered from the active chat note (tool calls/results and edit
 * outcomes as collapsible chips), a streaming partial card, and the
 * milestone-24 composer (context chips, auto-grow, model row) extended
 * with image chips — pasted/dropped images are staged into the vault via
 * `api.vault.saveAsset`.
 *
 * Deliberate divergences from the old Angular panel, recorded in the
 * stage-7 notes and kept here:
 * - the composer is a bare host CodeMirror view (the host's instances via
 *   `api.editor.cm`), so the inline spellchecker (a base Angular service)
 *   does not run here;
 * - a manual Action's noop/error message shows as a quiet line in the panel
 *   (it used to sit in the editor meta bar, which is base UI);
 * - the @-completion opens on a bare `@`: in a one-line composer the popup
 *   IS the affordance.
 */
import type { Extension } from '@codemirror/state';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { SdkTaskRecord } from '../../../shared/plugin-api/renderer';
import type { ChatNoteTurn, ChatToolEntry } from '../shared/chat-note.js';
import { ipcErrorMessage } from '../shared/format.js';
import {
  STAGE_IMAGE_EXTENSIONS,
  extensionOf,
  externalFileKind,
  stagedAttachmentsDir,
  uniqueStagedName,
} from '../shared/stage.js';
import type { AssistantState } from './state.js';
import type { RunningTasks } from './running-tasks.js';
import { deriveVaultScope } from '../shared/semantic.js';
import { createVaultFileCache, type VaultFileCache } from './vault-files.js';
import { PROMPTS_DIR, promptEntriesFrom, type PromptEntry } from './prompts.js';
import { renderRichBody } from './rich-text.js';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

type IconName =
  | 'check'
  | 'arrow-up'
  | 'copy'
  | 'corner-down-left'
  | 'rotate-ccw'
  | 'wrench'
  | 'pencil'
  | 'plus'
  | 'list'
  | 'search';

/** The Lucide glyphs the panel uses (same paths as `src/app/icons/icon.ts`). */
const ICON_PATHS: Record<IconName, readonly string[]> = {
  check: ['M20 6 9 17l-5-5'],
  plus: ['M5 12h14', 'M12 5v14'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
  copy: [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  ],
  'corner-down-left': ['M20 4v7a4 4 0 0 1-4 4H4', 'm9 10-5 5 5 5'],
  'rotate-ccw': ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  wrench: [
    'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  ],
  pencil: ['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  search: ['m21 21-4.34-4.34', 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z'],
};

function icon(name: IconName, size = 12): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** `daily/2026-09-26.md` -> `2026-09-26.md`. */
function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** `daily/2026-09-26.md` -> `daily` (no trailing slash). */
function dirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** The slice of a host CodeMirror view the panel touches. */
interface ComposerView {
  destroy(): void;
  focus(): void;
  // Deliberately loose: the structural type must stay assignable from the
  // real EditorView, whose dispatch is overloaded.
  dispatch(tr: unknown): void;
  /** Full content height in px — drives the auto-growing composer. */
  readonly contentHeight: number;
  state: { doc: { toString(): string; length: number } };
}

/** The slice of a CodeMirror Compartment the panel touches. */
interface CompartmentLike {
  of(value: unknown): unknown;
  reconfigure(value: unknown): unknown;
}

export interface PanelHandle {
  cleanup(): void;
}

export function mountPanel(
  body: HTMLElement,
  api: DreyPluginApi,
  state: AssistantState,
  tasks: RunningTasks,
): PanelHandle {
  body.classList.add('assistant-panel');

  // -- head: the chat selector -----------------------------------------------
  // Icon-only controls (ADR-0057) + the active chat's title as a muted
  // label (57e): it reads from the live chat list (and the loaded view as
  // a fallback), so it is never stale — the model-named title replaces
  // the question placeholder through the change round.
  const chatLabel = el('span', 'chat-label');
  const chatSwitchButton = el('button', 'chat-switch') as HTMLButtonElement;
  chatSwitchButton.type = 'button';
  chatSwitchButton.title = 'Switch chat';
  chatSwitchButton.setAttribute('aria-label', 'Switch chat');
  chatSwitchButton.appendChild(icon('list', 13));
  chatSwitchButton.addEventListener('click', openChatPicker);
  const chatNewButton = el('button', 'chat-new') as HTMLButtonElement;
  chatNewButton.type = 'button';
  chatNewButton.title = 'Start a new chat';
  chatNewButton.setAttribute('aria-label', 'Start a new chat');
  chatNewButton.appendChild(icon('plus', 13));
  chatNewButton.addEventListener('click', () => state.newChat());

  const head = el('header', 'assistant-head');
  const chatHead = el('div', 'chat-head');
  chatHead.append(chatLabel, chatSwitchButton, chatNewButton);
  head.append(chatHead);
  body.appendChild(head);

  // -- thread ----------------------------------------------------------------
  const thread = el('div', 'assistant-thread');
  body.appendChild(thread);

  let confirmingRestart: number | null = null;
  let copiedTurnIndex: number | null = null;
  /** Expanded tool-chip bodies, keyed `${turnIndex}:${i}` (session state). */
  const expandedChips = new Set<string>();

  /** The `tasks_list` tool whose persisted result renders as a task block. */
  const TASKS_LIST_TOOL = 'tasks_list';

  /** Parses one `tasks_list` tool result: JSON lines of records (+ a truncation note). */
  const parseTasksResult = (
    content: string,
  ): { records: SdkTaskRecord[]; truncated: number } => {
    const records: SdkTaskRecord[] = [];
    let truncated = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (typeof record['text'] === 'string' && typeof record['path'] === 'string') {
            records.push(parsed as SdkTaskRecord);
          } else if (typeof record['truncated'] === 'number') {
            truncated = record['truncated'];
          }
        }
      } catch {
        // A stray line stays unparsed — the rows carry real data only.
      }
    }
    return { records, truncated };
  };

  /**
   * The filter chips one `tasks_list` call's arguments describe (57c):
   * `#tag`, quoted text terms, overdue, completed / done-included — rendered in the
   * block head so a filtered view explains itself. Unparseable args
   * (the `{"posthoc":true}` sentinel among them) yield no chips.
   */
  const taskFilterLabelParts = (argsJson: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(argsJson || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return [];
      }
      const args = parsed as Record<string, unknown>;
      const parts: string[] = [];
      if (typeof args['tag'] === 'string' && args['tag'].trim() !== '') {
        parts.push(`#${args['tag'].trim().replace(/^#/, '')}`);
      }
      if (typeof args['text'] === 'string' && args['text'].trim() !== '') {
        parts.push(`"${args['text'].trim()}"`);
      }
      if (args['overdue'] === true) {
        parts.push('overdue');
      }
      const since = args['completedSince'];
      const hasSince = typeof since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(since);
      if (args['status'] === 'done' || hasSince) {
        parts.push(hasSince ? `completed since ${since as string}` : 'completed');
      } else if (args['includeDone'] === true || args['status'] === 'all') {
        parts.push('done included');
      }
      return parts;
    } catch {
      return [];
    }
  };

  /**
   * The interactive task block replacing the `tasks_list` chip pair
   * (SDK 1.11): rows with checkbox / text / priority / due badge, a click
   * on the row opens the note at the line, the checkbox completes the
   * task through the task provider (the tasks plugin owns the line
   * grammar). The fence rows are a snapshot — the LIVE done/due state
   * hydrates from the provider right after mount. Rows arrive in the
   * provider's deterministic view order (importance by default); the
   * block never re-sorts.
   */
  const taskListNode = (
    initial: readonly SdkTaskRecord[],
    truncated: number,
    filterParts: readonly string[] = [],
  ): HTMLElement => {
    const box = el('div', 'task-block');
    let records = [...initial];

    const head = el('div', 'task-block-head');
    head.appendChild(icon('check', 11));
    head.appendChild(
      el('span', undefined, `Tasks · ${records.length}${truncated > 0 ? ` (+${truncated} more)` : ''}`),
    );
    if (filterParts.length > 0) {
      head.appendChild(el('span', 'task-block-filter', filterParts.join(' · ')));
    }
    box.appendChild(head);

    const rowsBox = el('div', 'task-block-rows');
    box.appendChild(rowsBox);
    const errorLine = el('div', 'task-block-error');
    errorLine.hidden = true;
    box.appendChild(errorLine);

    const dueBadge = (task: SdkTaskRecord): HTMLElement | null => {
      if (task.due === null) {
        return null;
      }
      const today = new Date();
      const pad = (v: number): string => String(v).padStart(2, '0');
      const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      const overdue = !task.done && task.due < todayStr;
      const soon = !task.done && task.due === todayStr;
      return el('span', `task-due${overdue ? ' overdue' : soon ? ' today' : ''}`, task.due);
    };

    const renderRows = (): void => {
      rowsBox.replaceChildren();
      for (const [index, task] of records.entries()) {
        const row = el('div', 'task-row' + (task.done ? ' done' : ''));

        const check = el('button', 'task-check' + (task.done ? ' checked' : '')) as HTMLButtonElement;
        check.type = 'button';
        check.appendChild(icon('check', 10));
        check.title = task.done ? 'Re-open this task' : 'Complete this task';
        check.setAttribute('aria-label', check.title);
        check.addEventListener('click', (event) => {
          event.stopPropagation();
          void (async () => {
            check.disabled = true;
            try {
              const updated = (await api.backend.invoke('tasks:setDone', {
                task,
                done: !task.done,
              })) as SdkTaskRecord;
              records[index] = updated;
              renderRows();
            } catch (err) {
              errorLine.textContent = `Could not update the task: ${ipcErrorMessage(err)}`;
              errorLine.hidden = false;
              check.disabled = false;
            }
          })();
        });
        row.appendChild(check);

        const open = el('button', 'task-open') as HTMLButtonElement;
        open.type = 'button';
        open.appendChild(el('span', 'task-text', task.text));
        if (task.priority === 'highest') {
          open.appendChild(el('span', 'task-prio', '🔺'));
        } else if (task.priority === 'high') {
          open.appendChild(el('span', 'task-prio', '⏫'));
        } else if (task.priority === 'low') {
          open.appendChild(el('span', 'task-prio', '🔽'));
        }
        // A completed task shows WHEN it was completed (57d); its due
        // date no longer matters.
        if (task.done && typeof task.completed === 'string') {
          const completed = el('span', 'task-due', `✅ ${task.completed}`);
          completed.title = `Completed ${task.completed}`;
          open.appendChild(completed);
        } else {
          const due = dueBadge(task);
          if (due !== null) {
            open.appendChild(due);
          }
        }
        open.title = `${task.path}:${task.line}${task.heading !== null ? ` — ${task.heading}` : ''}`;
        open.addEventListener('click', () => {
          void api.documents.open(task.path, task.line, { vaultId: task.vaultId });
        });
        row.appendChild(open);
        rowsBox.appendChild(row);
      }
      if (records.length === 0) {
        rowsBox.appendChild(el('div', 'task-block-empty', 'No tasks in this result.'));
      }
    };
    renderRows();

    // The fence is a snapshot; the live index is the truth (same
    // fresh-hydration rule as the vault context). Same length expected —
    // anything else keeps the persisted rows visible.
    void (async () => {
      try {
        const current = (await api.backend.invoke('tasks:hydrate', {
          records,
        })) as SdkTaskRecord[];
        if (Array.isArray(current) && current.length === records.length) {
          records = current;
          renderRows();
        }
      } catch {
        // The persisted rows stand.
      }
    })();

    return box;
  };

  /** One persisted `drey-tool` entry as a collapsible chip. */
  const toolChipNode = (entry: ChatToolEntry, key: string): HTMLElement => {
    const expanded = expandedChips.has(key);
    const chip = el('div', 'tool-chip' + (expanded ? ' open' : ''));
    const summary = el('button', 'tool-chip-summary') as HTMLButtonElement;
    summary.type = 'button';
    let text: string;
    if (entry.kind === 'call') {
      text = `tool · ${toolDisplayName(entry.name)}(${summarizeArguments(entry.arguments)})`;
    } else if (entry.kind === 'result') {
      text = `result · ${firstLine(entry.content)}`;
    } else {
      text = entry.applied
        ? `applied change · ${entry.path}`
        : `discarded proposal · ${entry.path}`;
    }
    summary.appendChild(icon('wrench', 10));
    summary.appendChild(el('span', undefined, text));
    summary.addEventListener('click', () => {
      if (expanded) {
        expandedChips.delete(key);
      } else {
        expandedChips.add(key);
      }
      render();
    });
    chip.appendChild(summary);
    if (expanded) {
      const pre = el('pre', 'tool-chip-body');
      pre.textContent =
        entry.kind === 'call'
          ? `vault tool call\n${entry.name}\n\n${formatArguments(entry.arguments)}`
          : entry.kind === 'result'
            ? entry.content
            : (entry.after ?? 'The proposal was discarded without changes.');
      chip.appendChild(pre);
    }
    return chip;
  };

  const turnNode = (turn: ChatNoteTurn, index: number): HTMLElement => {
    const article = el('article', 'card');
    article.classList.add(turn.role === 'user' ? 'q' : 'a');

    const label = el('div', 'card-label');
    label.appendChild(document.createTextNode(turn.role === 'user' ? 'YOU' : 'ASSISTANT'));
    if (turn.at !== null && turn.at.length >= 16) {
      label.appendChild(el('span', 'at', ` · ${turn.at.slice(11, 16)}`));
    }
    const took = state.took(turn.meta.durationMs);
    if (took !== null) {
      label.appendChild(el('span', 'took', ` · ${took}`));
    }
    article.appendChild(label);

    for (let i = 0; i < turn.tool.length; i++) {
      const entry = turn.tool[i];
      // A `tasks_list` call + result renders as the interactive task
      // block instead of two chips (the paired result chip is skipped
      // with the call); an unparseable result falls back to the plain
      // chips (raw data over a broken widget).
      if (entry.kind === 'call' && entry.name === TASKS_LIST_TOOL) {
        const resultIndex = turn.tool.findIndex(
          (e) => e.kind === 'result' && e.id === entry.id,
        );
        const result = resultIndex >= 0 ? turn.tool[resultIndex] : undefined;
        if (result !== undefined && result.kind === 'result') {
          const { records, truncated } = parseTasksResult(result.content);
          // A filtered query can legitimately match nothing — the
          // provider's exact empty marker renders as an empty block
          // (with its filter chips) instead of falling back to chips.
          if (
            records.length > 0 ||
            truncated > 0 ||
            result.content.trim() === 'No tasks found.'
          ) {
            article.appendChild(
              taskListNode(
                records,
                truncated,
                // Persisted call arguments are a string or an object
                // (readable-written fences) — both parse.
                taskFilterLabelParts(
                  typeof entry.arguments === 'string'
                    ? entry.arguments
                    : JSON.stringify(entry.arguments ?? {}),
                ),
              ),
            );
            if (resultIndex > i) {
              i = resultIndex; // resume after the paired result
            }
            continue;
          }
          // The pair exists but parsed to nothing — surface WHY in the
          // console instead of silently degrading to raw chips.
          console.warn(
            `[assistant] tasks_list result did not parse to records (first 120 chars): ${result.content.slice(0, 120)}`,
          );
        }
      }
      article.appendChild(toolChipNode(entry, `${index}:${i}`));
    }

    // Retrieved-vault citations (ADR-0055): one collapsible chip listing
    // what this turn consulted; a click opens the source file. A chip-on
    // turn with NO hits still gets a chip — the persisted contextStatus
    // says why (floor / disabled / failed) instead of silent nothing.
    if (turn.context.length > 0 || turn.contextStatus !== null) {
      const key = `${index}:ctx`;
      const expanded = expandedChips.has(key);
      const chip = el('div', 'tool-chip context-chip' + (expanded ? ' open' : ''));
      const summary = el('button', 'tool-chip-summary') as HTMLButtonElement;
      summary.type = 'button';
      summary.appendChild(icon('search', 10));
      const status = turn.contextStatus;
      if (status === null) {
        summary.appendChild(
          el(
            'span',
            undefined,
            `vault context · ${turn.context.length} section${turn.context.length === 1 ? '' : 's'}`,
          ),
        );
      } else if (status.kind === 'empty') {
        chip.classList.add('muted');
        summary.appendChild(
          el(
            'span',
            undefined,
            `vault context · no sections above the score floor (${status.floor.toFixed(2)})`,
          ),
        );
      } else if (status.kind === 'disabled') {
        chip.classList.add('muted');
        summary.appendChild(
          el('span', undefined, 'vault context · retrieval is off in Settings → Assistant retrieval'),
        );
      } else if (status.kind === 'unregistered') {
        chip.classList.add('muted');
        summary.appendChild(
          el('span', undefined, 'vault context · the selected vaults are no longer registered'),
        );
      } else {
        chip.classList.add('muted');
        summary.appendChild(el('span', undefined, `vault context failed · ${firstLine(status.message)}`));
      }
      summary.addEventListener('click', () => {
        if (expanded) {
          expandedChips.delete(key);
        } else {
          expandedChips.add(key);
        }
        render();
      });
      chip.appendChild(summary);
      if (expanded) {
        const list = el('div', 'tool-chip-body context-list');
        if (status === null) {
          for (const cite of turn.context) {
            const row = el('button', 'context-cite') as HTMLButtonElement;
            row.type = 'button';
            const where =
              cite.vault !== undefined ? `${cite.vault} · ${baseName(cite.path)}` : baseName(cite.path);
            row.textContent = `${where} — ${cite.heading}`;
            row.title = `${cite.vault !== undefined ? `${cite.vault} · ` : ''}${cite.path} (line ${cite.line}) — click to open`;
            row.addEventListener('click', () => {
              void api.documents.open(cite.path, cite.line > 0 ? cite.line : undefined);
            });
            list.appendChild(row);
          }
        } else if (status.kind === 'empty') {
          const hint = el('div', 'context-hint');
          hint.textContent =
            'Nothing matched above the similarity cutoff. Raise k or lower the minimum score under Settings → Assistant retrieval.';
          list.appendChild(hint);
        } else if (status.kind === 'disabled') {
          const hint = el('div', 'context-hint');
          hint.textContent =
            'The Vault chip was on, but semantic retrieval is turned off. Enable it under Settings → Assistant retrieval (the first build downloads the embedding model once).';
          list.appendChild(hint);
        } else if (status.kind === 'unregistered') {
          const hint = el('div', 'context-hint');
          hint.textContent =
            'The vault selection referenced vaults that are no longer registered. Pick the vaults again with the Vault chip.';
          list.appendChild(hint);
        } else {
          const hint = el('div', 'context-hint');
          hint.textContent = status.message;
          list.appendChild(hint);
        }
        chip.appendChild(list);
      }
      article.appendChild(chip);
    }

    if (turn.text !== '') {
      const hasEditChip = turn.tool.some((entry) => entry.kind === 'edit');
      if (!(hasEditChip && turn.text.startsWith('[Proposed a change to'))) {
        article.appendChild(renderRichBody(api, turn.text));
      }
    }

    if (turn.role === 'user' && turn.attachments.length > 0) {
      const att = el('div', 'card-attachments');
      for (const attachment of turn.attachments) {
        const link = el('button', 'attachment') as HTMLButtonElement;
        link.type = 'button';
        link.textContent =
          attachment.kind === 'note' ? `[[${baseName(attachment.path)}]]` : `![${attachment.path}]`;
        link.title = attachment.path;
        link.addEventListener('click', () => {
          void api.documents.open(attachment.path);
        });
        att.appendChild(link);
      }
      article.appendChild(att);
    }

    if (confirmingRestart === index) {
      const confirm = el('div', 'card-confirm');
      const count = state.laterCount(index);
      confirm.appendChild(
        el('span', undefined, `Remove ${count} message${count === 1 ? '' : 's'}?`),
      );
      const restartBtn = el('button', undefined, 'Restart') as HTMLButtonElement;
      restartBtn.type = 'button';
      restartBtn.addEventListener('click', () => {
        confirmingRestart = null;
        void state.restartFrom(index).then((question) => {
          if (question !== null) {
            setComposerText(question);
            composerView?.focus();
          }
        });
      });
      const cancelBtn = el('button', 'ghost', 'Cancel') as HTMLButtonElement;
      cancelBtn.type = 'button';
      cancelBtn.addEventListener('click', () => {
        confirmingRestart = null;
        render();
      });
      confirm.append(restartBtn, cancelBtn);
      article.appendChild(confirm);
    } else {
      const actions = el('div', 'card-actions');
      if (turn.role === 'user') {
        const restart = el('button') as HTMLButtonElement;
        restart.type = 'button';
        restart.title = 'Restart chat from here';
        restart.disabled = tasks.isRunning();
        restart.appendChild(icon('rotate-ccw'));
        restart.addEventListener('click', () => {
          confirmingRestart = index;
          render();
        });
        actions.appendChild(restart);
      } else if (turn.text !== '') {
        const insert = el('button') as HTMLButtonElement;
        insert.type = 'button';
        insert.title = 'Insert into note';
        insert.disabled = state.notePath() === null;
        insert.appendChild(icon('corner-down-left'));
        insert.addEventListener('click', () => {
          api.documents.insertAtCursor(turn.text);
        });
        actions.appendChild(insert);
      }
      const copy = el('button') as HTMLButtonElement;
      copy.type = 'button';
      copy.title = copiedTurnIndex === index ? 'Copied' : 'Copy to clipboard';
      copy.replaceChildren(icon(copiedTurnIndex === index ? 'check' : 'copy'));
      copy.addEventListener('click', () => {
        void navigator.clipboard
          .writeText(turn.text)
          .then(() => {
            copiedTurnIndex = index;
            render();
            setTimeout(() => {
              if (copiedTurnIndex === index) {
                copiedTurnIndex = null;
                render();
              }
            }, 1200);
          })
          .catch(() => {
            // Clipboard access denied -- nothing useful to do from the panel.
          });
      });
      actions.appendChild(copy);
      article.appendChild(actions);
    }
    return article;
  };

  const emptyStateText = (): string => {
    if (!api.llm.enabled()) {
      return 'LLM features are off — nothing is answered.';
    }
    return 'New chat — ask anything. A note or file chip gives it context.';
  };

  const renderThread = (): void => {
    // Stick-to-bottom (req: the transcript follows the streamed text):
    // remember whether the user is pinned to the bottom BEFORE the rebuild
    // wipes the children -- scrolling up unpins until they return to the
    // bottom. Pinned is the default (also for the empty first render).
    const pinned =
      thread.clientHeight === 0 ||
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
    thread.textContent = '';

    const currentView = state.view();
    const turns = currentView?.turns ?? [];
    if (turns.length === 0 && state.streaming() === null) {
      thread.appendChild(el('p', 'empty', emptyStateText()));
    }
    for (let index = 0; index < turns.length; index++) {
      try {
        thread.appendChild(turnNode(turns[index], index));
      } catch (error) {
        // One broken turn must never blank the thread (the render wipes
        // first): an error card stands in, the console names the cause.
        console.warn(`[assistant] turn ${index} failed to render:`, error);
        const card = el('article', 'card a');
        card.appendChild(el('div', 'card-label', 'ASSISTANT'));
        card.appendChild(el('p', 'notice', 'This turn could not be rendered.'));
        thread.appendChild(card);
      }
    }

    // The streamed partial answer: one card that grows while the model
    // talks. Providers without incremental streaming still call once, so
    // the card simply appears with the full text near the end.
    const streaming = state.streaming();
    if (streaming !== null) {
      const partial = el('article', 'card a streaming');
      partial.appendChild(el('div', 'card-label', 'ASSISTANT'));
      const bodyText = streaming.text === '' ? '…' : streaming.text;
      try {
        partial.appendChild(renderRichBody(api, bodyText));
      } catch (error) {
        console.warn('[assistant] streaming render fell back to plain text:', error);
        partial.appendChild(el('p', 'card-body', bodyText));
      }
      thread.appendChild(partial);
    }

    // No timeout on a local model (ADR-0014): the elapsed counter says
    // "still working" and Cancel is what ends it.
    const running = tasks.currentLabel();
    if (running !== null) {
      const working = el('p', 'working');
      working.appendChild(el('span', 'at', running));
      const cancel = el('button', 'cancel', 'Cancel') as HTMLButtonElement;
      cancel.type = 'button';
      cancel.addEventListener('click', () => void state.cancelRunning());
      working.appendChild(cancel);
      thread.appendChild(working);
    }
    const notice = state.notice();
    if (notice !== null) {
      const line = el('p', 'notice', notice);
      line.title = 'Dismiss';
      line.addEventListener('click', () => state.dismiss());
      thread.appendChild(line);
    }
    const error = state.error();
    if (error !== null) {
      const line = el('p', 'err', error);
      line.title = 'Dismiss';
      line.addEventListener('click', () => state.dismiss());
      thread.appendChild(line);
    }
    const actionMessage = state.actionMessage();
    if (actionMessage !== null) {
      const line = el('p', 'err notice', actionMessage);
      line.title = 'Dismiss';
      line.addEventListener('click', () => state.dismissActionMessage());
      thread.appendChild(line);
    }

    if (pinned) {
      thread.scrollTop = thread.scrollHeight;
    }
  };

  // -- composer --------------------------------------------------------------
  // Claude-Code-style: context chips on top (the note by default, files via
  // @ or the + picker, images via the picker's Images tab or paste/drop),
  // an auto-growing input, and a meta row with the model picker.
  const composer = el('footer', 'assistant-composer');
  const chipsRow = el('div', 'composer-chips');
  const composerHost = el('div', 'composer-input');
  const sendButton = el('button', 'send') as HTMLButtonElement;
  sendButton.type = 'button';
  sendButton.setAttribute('aria-label', 'Send question');
  sendButton.appendChild(icon('arrow-up', 13));
  // The composer's tools are icon-only (milestone 43): the words live in
  // each button's `title` + `aria-label`.
  const toolButton = (className: string, iconName: string): HTMLButtonElement => {
    const node = el('button', `icon-btn ${className}`) as HTMLButtonElement;
    node.type = 'button';
    node.appendChild(api.ui.icon(iconName, 14));
    return node;
  };
  const plusButton = toolButton('plus', 'paperclip');
  plusButton.title = 'Attach a file or image';
  plusButton.setAttribute('aria-label', 'Attach a file or image');
  // The live-edit toggle (ADR-0049): when on, the next ask applies the
  // model's changes to the open note immediately.
  const liveButton = toolButton('live', 'pencil-line');
  liveButton.title =
    'Live edit: let the assistant edit this note directly — changes apply immediately (no confirmation). Undo with Ctrl+Z, save with Ctrl+S.';
  liveButton.setAttribute('aria-label', 'Toggle live edit');
  // The Vault toggle (ADR-0055): a click opens the picker — off, the
  // active vault, all vaults, or any subset (e.g. a non-active Git
  // vault); each ask then retrieves the most similar note sections of
  // the selection as context.
  const vaultButton = toolButton('vault', 'database');
  vaultButton.setAttribute('aria-label', 'Pick the vault context');
  const row = el('div', 'composer-row');
  row.append(composerHost, sendButton);
  const modelButton = el('button', 'model-btn', '…') as HTMLButtonElement;
  modelButton.type = 'button';
  modelButton.title = 'Pick the model';
  modelButton.setAttribute('aria-label', 'Pick the model');
  const promptsButton = toolButton('prompt-btn', 'book-open');
  promptsButton.title = 'Prompts: pick one from templates/prompts/';
  promptsButton.setAttribute('aria-label', 'Pick a prompt');
  promptsButton.addEventListener('click', () => void openPromptPicker());
  const meta = el('div', 'composer-meta');
  meta.append(plusButton, liveButton, vaultButton, promptsButton, modelButton);
  const box = el('div', 'composer-box');
  box.append(chipsRow, row);
  composer.append(box, meta);
  body.appendChild(composer);

  const chipNode = (path: string, kind: 'note' | 'file' | 'image' | 'scratch'): HTMLElement => {
    const chip = el('span', kind === 'file' ? 'chip' : `chip ${kind}`);
    chip.title =
      kind === 'scratch'
        ? `Unsaved tab: ${path} — attached via a .drafts/ snapshot at send time`
        : path;
    chip.appendChild(el('span', 'chip-name', baseName(path)));
    const remove = el('button', 'chip-x', '×') as HTMLButtonElement;
    remove.type = 'button';
    remove.title =
      kind === 'note' ? 'Exclude this note from the context' : 'Remove from the context';
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => {
      if (kind === 'note') {
        state.setNoteIncluded(false);
      } else if (kind === 'image') {
        state.removeImage(path);
      } else if (kind === 'scratch') {
        state.removeScratch(path);
      } else {
        state.removeFile(path);
      }
    });
    chip.appendChild(remove);
    return chip;
  };

  const renderChips = (): void => {
    chipsRow.textContent = '';
    const liveOn = state.liveEdit();
    liveButton.classList.toggle('on', liveOn);
    liveButton.setAttribute('aria-pressed', String(liveOn));
    const scope = state.vaultScope();
    vaultButton.classList.toggle('on', scope !== 'off');
    vaultButton.classList.toggle('all', scope === 'all');
    vaultButton.setAttribute('aria-pressed', String(scope !== 'off'));
    vaultButton.title = vaultScopeTitle(state);
    const path = state.notePath();
    if (path !== null && state.noteIncluded()) {
      chipsRow.appendChild(chipNode(path, 'note'));
    }
    for (const file of state.extraFiles()) {
      chipsRow.appendChild(chipNode(file, 'file'));
    }
    for (const scratch of state.scratchFiles()) {
      chipsRow.appendChild(chipNode(scratch.docPath, 'scratch'));
    }
    for (const image of state.images()) {
      chipsRow.appendChild(chipNode(image, 'image'));
    }
  };

  // -- auto-grow ---------------------------------------------------------------
  // The input is one line tall by default and grows with its content up to
  // a share of the panel, then scrolls inside — the composer never pushes
  // the thread away.
  const composerCap = (): number =>
    Math.max(88, Math.min(300, Math.round(body.clientHeight * 0.4)));
  const sizeComposer = (): void => {
    const view = composerView;
    if (view === null) {
      return;
    }
    composerHost.style.height = `${Math.round(Math.min(view.contentHeight, composerCap()))}px`;
  };
  const resizeObserver = new ResizeObserver(() => sizeComposer());
  resizeObserver.observe(body);

  // -- the model row -----------------------------------------------------------
  // The picker edits the ONE globally configured model (llm.model in the
  // app config) — the same value Settings -> LLM writes; the transport
  // re-reads it per call, so it applies to the very next question.
  let modelLabel: string | null | undefined = undefined; // undefined = not loaded yet
  const renderModelLabel = (): void => {
    modelButton.textContent =
      modelLabel === undefined ? '…' : (modelLabel ?? 'No model set');
  };
  const refreshModelLabel = (): void => {
    void api.appConfig
      .get()
      .then((config) => {
        modelLabel = config.llm.model;
        renderModelLabel();
      })
      .catch(() => {
        // The label stays as it is; the picker itself still works.
      });
  };

  const applyModelValue = async (value: string): Promise<void> => {
    const model = value.trim();
    const current = await api.appConfig.get();
    await api.appConfig.patch({
      llm: { ...current.llm, model: model === '' ? null : model },
    });
    modelLabel = model === '' ? null : model;
    renderModelLabel();
  };

  modelButton.addEventListener('click', openModelPicker);
  plusButton.addEventListener('click', openFilePicker);
  liveButton.addEventListener('click', () => state.toggleLiveEdit());
  vaultButton.addEventListener('click', openVaultPicker);
  refreshModelLabel();

  // -- the pickers (api.ui.showModal; same gesture as the templates picker) --

  function openChatPicker(): void {
    let close: () => void = () => undefined;
    let unsubscribe: (() => void) | null = null;

    const closePicker = (): void => {
      unsubscribe?.();
      unsubscribe = null;
      close();
    };

    const box = el('div', 'assistant-picker');
    const headLabel = el('div', 'assistant-picker-head', 'Chats');
    const bodyArea = el('div', 'assistant-picker-body');
    box.append(headLabel, bodyArea);

    const listBox = el('div', 'assistant-picker-list');
    const newRow = el('div', 'assistant-picker-row new-chat', 'New chat');
    newRow.addEventListener('click', () => {
      state.newChat();
      closePicker();
    });
    listBox.appendChild(newRow);

    const renderList = (): void => {
      // Rebuild everything below the "New chat" row: this also runs when
      // the (async) list lands or changes while the picker sits open.
      for (const row of listBox.querySelectorAll('.assistant-picker-row:not(.new-chat), .assistant-picker-empty')) {
        row.remove();
      }
      for (const chat of state.chats()) {
        const rowEl = el(
          'div',
          'assistant-picker-row' + (chat.path === state.activeChatPath() ? ' current' : ''),
          chat.title,
        );
        rowEl.appendChild(
          el('span', 'assistant-picker-detail', (chat.updated ?? '').slice(0, 16).replace('T', ' ')),
        );
        rowEl.title = chat.path;
        rowEl.addEventListener('click', () => {
          void state.openChat(chat.path);
          closePicker();
        });
        listBox.appendChild(rowEl);
      }
      if (state.chats().length === 0) {
        listBox.appendChild(
          el(
            'div',
            'assistant-picker-empty',
            state.chatsFailed()
              ? 'Chats could not be listed.'
              : 'No chats yet — the first question creates one.',
          ),
        );
      }
    };
    renderList();
    bodyArea.appendChild(listBox);

    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePicker();
      }
    });

    close = api.ui.showModal((mount) => {
      mount.classList.add('assistant-picker-host');
      mount.appendChild(box);
    });
    unsubscribe = state.subscribe(renderList);
    void state.invalidateChats();
  }

  function openModelPicker(): void {
    let close: () => void = () => undefined;
    let filter = '';
    let activeIndex = 0;
    let models: readonly string[] = [];
    let listingError: string | null = null;
    let canList = true;
    let filterInput: HTMLInputElement | null = null;
    let handInput: HTMLInputElement | null = null;

    const box = el('div', 'assistant-picker');
    const headLabel = el('div', 'assistant-picker-head', 'Model');
    const bodyArea = el('div', 'assistant-picker-body');
    box.append(headLabel, bodyArea);

    const visibleModels = (): readonly string[] => {
      const query = filter.trim().toLowerCase();
      return models.filter(
        (model) => query === '' || model.toLowerCase().includes(query),
      );
    };

    const choose = (model: string): void => {
      void applyModelValue(model);
      close();
    };

    const commitHand = (): void => {
      if (handInput !== null) {
        void applyModelValue(handInput.value);
      }
      close();
    };

    const renderList = (): void => {
      const listBox = bodyArea.querySelector('.assistant-picker-list');
      if (!(listBox instanceof HTMLElement)) {
        return;
      }
      listBox.textContent = '';
      const visible = visibleModels();
      if (activeIndex >= visible.length) {
        activeIndex = Math.max(0, visible.length - 1);
      }
      visible.forEach((model, index) => {
        const rowEl = el(
          'div',
          'assistant-picker-row' + (index === activeIndex ? ' active' : ''),
          model,
        );
        if (model === modelLabel) {
          rowEl.classList.add('current');
        }
        rowEl.addEventListener('click', () => choose(model));
        rowEl.addEventListener('mousemove', () => {
          if (activeIndex !== index) {
            activeIndex = index;
            renderList();
          }
        });
        listBox.appendChild(rowEl);
      });
      if (visible.length === 0) {
        listBox.appendChild(
          el(
            'div',
            'assistant-picker-empty',
            models.length === 0
              ? 'The provider lists no models — type the id below.'
              : 'No matching model',
          ),
        );
      }
    };

    const buildBody = (): void => {
      bodyArea.textContent = '';
      filterInput = null;
      handInput = null;
      if (listingError !== null) {
        bodyArea.appendChild(el('div', 'assistant-picker-note', listingError));
      }
      if (canList && models.length > 0) {
        filterInput = el('input', 'assistant-picker-input') as HTMLInputElement;
        filterInput.type = 'text';
        filterInput.placeholder = 'Filter models …';
        filterInput.addEventListener('input', () => {
          filter = filterInput?.value ?? '';
          activeIndex = 0;
          renderList();
        });
        bodyArea.appendChild(filterInput);
      }
      const listBox = el('div', 'assistant-picker-list');
      bodyArea.appendChild(listBox);
      const wrap = el('div', 'assistant-picker-hand');
      handInput = el('input', 'assistant-picker-input') as HTMLInputElement;
      handInput.type = 'text';
      handInput.placeholder = 'Model id, typed by hand …';
      handInput.value = modelLabel ?? '';
      handInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          commitHand();
        }
      });
      const applyBtn = el('button', 'assistant-picker-use', 'Use') as HTMLButtonElement;
      applyBtn.type = 'button';
      applyBtn.addEventListener('click', commitHand);
      wrap.append(handInput, applyBtn);
      bodyArea.appendChild(wrap);
      renderList();
      window.setTimeout(() => (filterInput ?? handInput)?.focus(), 0);
    };

    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.target !== filterInput) {
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const len = visibleModels().length;
        if (len > 0) {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          activeIndex = (activeIndex + delta + len) % len;
          renderList();
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const model = visibleModels()[activeIndex];
        if (model !== undefined) {
          choose(model);
        }
      }
    });

    close = api.ui.showModal((mount) => {
      mount.classList.add('assistant-picker-host');
      mount.appendChild(box);
    });

    // Re-fetched on every open: it reflects whatever provider is active
    // right now, and a switch in Settings is picked up without a restart.
    void api.llm
      .listModels()
      .then((listing) => {
        headLabel.textContent = listing.providerLabel;
        models = listing.models;
        canList = listing.modelListing;
        listingError = listing.error;
        buildBody();
      })
      .catch((err) => {
        // listModels resolves errors into `error`; this is belt and braces.
        listingError = err instanceof Error ? err.message : String(err);
        canList = false;
        models = [];
        buildBody();
      });
  }

  /**
   * The prompt picker (req: pick a prompt from the templates folder — the
   * successor of the removed "Summarise now"): lists `templates/prompts/`
   * Markdown files (title + description), and inserting one REPLACES the
   * composer's text — the user reviews and sends it as a normal question.
   */
  async function openPromptPicker(): Promise<void> {
    let close: () => void = () => undefined;

    const box = el('div', 'assistant-picker');
    const headLabel = el('div', 'assistant-picker-head', 'Prompts');
    const bodyArea = el('div', 'assistant-picker-body');
    box.append(headLabel, bodyArea);

    const listBox = el('div', 'assistant-picker-list');
    bodyArea.appendChild(listBox);

    let prompts: readonly PromptEntry[] = [];
    const renderList = (): void => {
      listBox.textContent = '';
      for (const prompt of prompts) {
        const rowEl = el('div', 'assistant-picker-row');
        rowEl.appendChild(el('span', 'row-title', prompt.title));
        if (prompt.description !== '') {
          rowEl.appendChild(el('span', 'assistant-picker-detail', prompt.description));
        }
        rowEl.title = prompt.path;
        rowEl.addEventListener('click', () => {
          close();
          const view = composerView;
          if (view === null) {
            return;
          }
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: prompt.body },
          });
          sizeComposer();
          view.focus();
        });
        listBox.appendChild(rowEl);
      }
      if (prompts.length === 0) {
        listBox.appendChild(
          el(
            'div',
            'assistant-picker-empty',
            `No prompts in ${PROMPTS_DIR}/ — add .md files there.`,
          ),
        );
      }
    };
    renderList();

    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });

    close = api.ui.showModal((mount) => {
      mount.classList.add('assistant-picker-host');
      mount.appendChild(box);
    });

    // Re-read on every open (the cache invalidates itself on vault changes).
    try {
      prompts = await promptEntriesFrom(await vaultFiles.ensureLoaded(), (path) =>
        api.vault.readFile(path).then((file) => file.content),
      );
      renderList();
    } catch {
      // The empty state stays; the read failure is not worth an error line.
    }
  }

  /**
   * The Vault chip's picker (ADR-0055 later change): three shortcut rows
   * — Off, the active vault, every vault — then one checkbox row per
   * registered vault. Toggling rows derives the scope live (none → off,
   * the active one → vault, all → all, any other subset → custom), so a
   * selection can target e.g. a non-active Git vault without making it
   * the default target for new content. Shortcuts apply and close; row
   * toggles keep the picker open for multi-select.
   */
  function openVaultPicker(): void {
    let close: () => void = () => undefined;
    let unsubscribe: (() => void) | null = null;

    const closePicker = (): void => {
      unsubscribe?.();
      unsubscribe = null;
      close();
    };

    const box = el('div', 'assistant-picker');
    const headLabel = el('div', 'assistant-picker-head', 'Vault context');
    const bodyArea = el('div', 'assistant-picker-body');
    box.append(headLabel, bodyArea);

    const listBox = el('div', 'assistant-picker-list');
    bodyArea.appendChild(listBox);
    const doneBtn = el('button', 'assistant-picker-foot', 'Done') as HTMLButtonElement;
    doneBtn.type = 'button';
    doneBtn.addEventListener('click', closePicker);
    bodyArea.appendChild(doneBtn);

    /** The ids a shortcut row stands for. */
    const shortcutIds = (scope: 'off' | 'vault' | 'all'): string[] => {
      const vaults = state.vaults();
      if (scope === 'all') {
        return vaults.map((vault) => vault.id);
      }
      if (scope === 'vault') {
        return vaults.filter((vault) => vault.active).map((vault) => vault.id);
      }
      return [];
    };

    const renderList = (): void => {
      listBox.textContent = '';
      const vaults = state.vaults();
      const scope = state.vaultScope();
      const checked =
        scope === 'all'
          ? shortcutIds('all')
          : scope === 'vault'
            ? shortcutIds('vault')
            : scope === 'custom'
              ? state.customVaultIds()
              : [];

      const shortcutRow = (label: string, detail: string, target: 'off' | 'vault' | 'all'): void => {
        const rowEl = el('div', 'assistant-picker-row' + (scope === target ? ' current' : ''));
        rowEl.appendChild(el('span', 'row-title', label));
        if (detail !== '') {
          rowEl.appendChild(el('span', 'assistant-picker-detail', detail));
        }
        rowEl.addEventListener('click', () => {
          state.setVaultScope(target, shortcutIds(target));
          closePicker();
        });
        listBox.appendChild(rowEl);
      };

      const active = vaults.find((vault) => vault.active) ?? null;
      shortcutRow('Off', '', 'off');
      shortcutRow('Active vault', active !== null ? active.name : 'none registered', 'vault');
      shortcutRow('All vaults', `${vaults.length} registered`, 'all');
      listBox.appendChild(el('div', 'assistant-picker-sep'));

      for (const vault of vaults) {
        const isChecked = checked.includes(vault.id);
        const rowEl = el('div', 'assistant-picker-row vault-choice');
        const check = el('span', 'row-check');
        if (isChecked) {
          check.appendChild(icon('check', 10));
        }
        rowEl.appendChild(check);
        rowEl.appendChild(el('span', 'row-title', vault.name));
        rowEl.appendChild(el('span', 'assistant-picker-detail', vault.active ? 'active' : ''));
        rowEl.title = vault.name;
        rowEl.setAttribute('role', 'checkbox');
        rowEl.setAttribute('aria-checked', String(isChecked));
        rowEl.addEventListener('click', () => {
          const next = isChecked
            ? checked.filter((id) => id !== vault.id)
            : [...checked, vault.id];
          const derived = deriveVaultScope(next, vaults);
          state.setVaultScope(derived.scope, derived.vaultIds);
          // renderList rides the state subscription; nothing else to do.
        });
        listBox.appendChild(rowEl);
      }
      if (vaults.length === 0) {
        listBox.appendChild(
          el('div', 'assistant-picker-empty', 'No vaults registered — add one in the Files panel.'),
        );
      }
    };
    renderList();

    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePicker();
      }
    });

    close = api.ui.showModal((mount) => {
      mount.classList.add('assistant-picker-host');
      mount.appendChild(box);
    });
    unsubscribe = state.subscribe(renderList);
    void state.refreshVaults(); // names + a possibly-pruned selection
  }

  function openFilePicker(): void {
    let close: () => void = () => undefined;
    let filter = '';
    let activeIndex = 0;
    let files: readonly string[] = [];
    let images: readonly string[] = [];
    let tab: 'files' | 'images' = 'files';
    const notePath = state.notePath();

    const box = el('div', 'assistant-picker');
    const headLabel = el('div', 'assistant-picker-head', 'Attach');
    const bodyArea = el('div', 'assistant-picker-body');
    box.append(headLabel, bodyArea);

    const tabsRow = el('div', 'assistant-picker-tabs');
    const filesTab = el('button', 'assistant-picker-tab active', 'Files') as HTMLButtonElement;
    const imagesTab = el('button', 'assistant-picker-tab', 'Images') as HTMLButtonElement;
    filesTab.type = 'button';
    imagesTab.type = 'button';
    const setTab = (which: 'files' | 'images'): void => {
      tab = which;
      filesTab.classList.toggle('active', which === 'files');
      imagesTab.classList.toggle('active', which === 'images');
      renderList();
    };
    filesTab.addEventListener('click', () => setTab('files'));
    imagesTab.addEventListener('click', () => setTab('images'));
    tabsRow.append(filesTab, imagesTab);

    const filterInput = el('input', 'assistant-picker-input') as HTMLInputElement;
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter …';
    const listBox = el('div', 'assistant-picker-list');
    const foot = el(
      'button',
      'assistant-picker-foot',
      'Add a file from this computer …',
    ) as HTMLButtonElement;
    foot.type = 'button';
    foot.title = 'Stage a file that is not in the vault yet (copied into the chat attachments)';
    foot.addEventListener('click', () => {
      void state.attachExternal().then((landed) => {
        if (landed > 0) {
          close();
        }
      });
    });
    bodyArea.append(tabsRow, filterInput, listBox, foot);

    /** One selectable row: a vault file/image, or an unsaved scratch tab. */
    interface PickRow {
      id: string;
      scratch: boolean;
      label: string;
      detail: string;
      title: string;
    }

    /**
     * Unsaved scratch tabs (e.g. the search summary) — re-collected on
     * every render, so a tab opened while the picker sits open shows up.
     * The focused tab is hidden while its note chip carries it (same rule
     * as the open note among the vault files).
     */
    const scratchRows = (): PickRow[] =>
      api.documents
        .list()
        .filter(
          (doc) =>
            doc.kind === 'text' &&
            doc.saved === '' &&
            doc.dirty &&
            !(doc.path === notePath && state.noteIncluded()),
        )
        .map((doc) => ({
          id: doc.path,
          scratch: true,
          label: baseName(doc.path),
          detail: 'unsaved tab',
          title: `Unsaved tab: ${doc.path} — its live text is attached (snapshotted to .drafts/ when sent)`,
        }));

    const rows = (): readonly PickRow[] => {
      const query = filter.trim().toLowerCase();
      const matches = (label: string, hay: string): boolean =>
        query === '' || label.startsWith(query) || hay.includes(query);
      if (tab === 'images') {
        return images
          .filter((path) => matches(baseName(path).toLowerCase(), path.toLowerCase()))
          .map((path) => ({
            id: path,
            scratch: false,
            label: baseName(path),
            detail: dirName(path),
            title: path,
          }));
      }
      const vaultRows = files
        .filter((path) => {
          if (path === notePath && state.noteIncluded()) {
            return false; // already attached as the note chip
          }
          return matches(baseName(path).toLowerCase(), path.toLowerCase());
        })
        .map((path) => ({
          id: path,
          scratch: false,
          label: baseName(path),
          detail: dirName(path),
          title: path,
        }));
      return [...scratchRows(), ...vaultRows];
    };

    const choose = (row: PickRow): void => {
      const result = row.scratch
        ? state.addScratch(row.id)
        : tab === 'images'
          ? state.addImage(row.id)
          : state.addFile(row.id);
      if (result.ok) {
        close();
      }
    };

    const renderList = (): void => {
      listBox.textContent = '';
      const visibleRows = rows();
      if (activeIndex >= visibleRows.length) {
        activeIndex = Math.max(0, visibleRows.length - 1);
      }
      visibleRows.forEach((row, index) => {
        const rowEl = el(
          'div',
          'assistant-picker-row' + (index === activeIndex ? ' active' : ''),
          row.label,
        );
        if (row.id === notePath && !row.scratch && !state.noteIncluded()) {
          rowEl.classList.add('this-note');
        }
        if (row.scratch) {
          rowEl.classList.add('scratch');
        }
        if (row.detail !== '') {
          rowEl.appendChild(el('span', 'assistant-picker-detail', row.detail));
        }
        rowEl.title = row.title;
        rowEl.addEventListener('click', () => choose(row));
        rowEl.addEventListener('mousemove', () => {
          if (activeIndex !== index) {
            activeIndex = index;
            renderList();
          }
        });
        listBox.appendChild(rowEl);
      });
      if (visibleRows.length === 0) {
        listBox.appendChild(
          el(
            'div',
            'assistant-picker-empty',
            tab === 'files'
              ? files.length === 0 && scratchRows().length === 0
                ? 'No markdown files in the vault.'
                : 'No matching file'
              : images.length === 0
                ? 'No images in the vault — paste or drop one into the composer.'
                : 'No matching image',
          ),
        );
      }
    };

    filterInput.addEventListener('input', () => {
      filter = filterInput.value;
      activeIndex = 0;
      renderList();
    });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const len = rows().length;
        if (len > 0) {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          activeIndex = (activeIndex + delta + len) % len;
          renderList();
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const row = rows()[activeIndex];
        if (row !== undefined) {
          choose(row);
        }
      }
    });

    close = api.ui.showModal((mount) => {
      mount.classList.add('assistant-picker-host');
      mount.appendChild(box);
      window.setTimeout(() => filterInput.focus(), 0);
    });

    void vaultFiles.ensureLoaded().then((loaded) => {
      files = loaded;
      renderList();
    });
    void vaultImages.ensureLoaded().then((loaded) => {
      images = loaded;
      renderList();
    });
  }

  // The panel's own views of the vault (the @ source and the pickers).
  const vaultFiles: VaultFileCache = createVaultFileCache(api, '.md');
  const vaultImages: VaultFileCache = createVaultFileCache(api, ...STAGE_IMAGE_EXTENSIONS);

  // -- external-file paste/drop staging ----------------------------------------
  // Files dropped or pasted onto the composer — vault files OR files from
  // anywhere — are staged into the vault (attachments/ beside the
  // reference note, ADR-0024) and land as chips: images hash-named via
  // saveAsset, text files name-preserving and uniqued, everything else
  // skipped. Resolves true when at least one file was routed (the event
  // is consumed so the editor doesn't also handle it).
  const stageExternalFile = async (file: File): Promise<boolean> => {
    const kind = externalFileKind(file.name);
    if (kind === null) {
      return false;
    }
    try {
      const reference = state.notePath() ?? state.activeChatPath() ?? 'chats/scratch.md';
      if (kind === 'image') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const assetPath = await api.vault.saveAsset(bytes, extensionOf(file.name), reference);
        state.addImage(assetPath);
        return true;
      }
      const dir = stagedAttachmentsDir(reference);
      const siblings = (await api.vault.listFiles())
        .filter((entry) => entry.type === 'file' && entry.relativePath.startsWith(`${dir}/`))
        .map((entry) => entry.relativePath.slice(dir.length + 1));
      const target = `${dir}/${uniqueStagedName(file.name, siblings)}`;
      await api.vault.writeFile(target, await file.text());
      state.addFile(target);
      return true;
    } catch {
      return false;
    }
  };

  const stageFromEvent = (event: DragEvent | ClipboardEvent): boolean => {
    const files =
      event instanceof DragEvent
        ? event.dataTransfer?.files
        : (event as ClipboardEvent).clipboardData?.files;
    if (files === undefined || files.length === 0) {
      return false;
    }
    // Consume the event whenever real files ride on it (the editor must
    // not also insert their content); routing happens async per file.
    for (const file of Array.from(files)) {
      void stageExternalFile(file);
    }
    return true;
  };

  // -- the CodeMirror composer -------------------------------------------------
  // The host's CodeMirror in a minimal configuration: @-completion over the
  // vault files (a pick deletes the @token and adds a chip instead of
  // inserting text), Enter sends, Shift+Enter breaks the line. The
  // completion keymap sits BEFORE the send binding, so Enter accepts an
  // open completion and only sends when none is active. The composer is
  // always editable — a standalone chat needs no open note.
  const cm = api.editor.cm;
  let composerView: ComposerView | null = null;

  const atFileSource = (context: CompletionContext): Promise<CompletionResult | null> =>
    vaultFiles.ensureLoaded().then((files) => {
      const token = context.matchBefore(/@[^\s@]*/);
      if (token === null) {
        return null;
      }
      // A bare `@` offers the whole list immediately — in a one-line
      // composer the popup is the affordance, there is no room for a
      // "press Mod-Space" hint.
      const query = token.text.slice(1).toLowerCase();
      const byName: string[] = [];
      const byPath: string[] = [];
      for (const path of files) {
        const base = baseName(path).toLowerCase();
        if (query === '' || base.startsWith(query)) {
          byName.push(path);
        } else if (path.toLowerCase().includes(query)) {
          byPath.push(path);
        }
      }
      const matches = [...byName, ...byPath].slice(0, 50);
      if (matches.length === 0) {
        return null;
      }
      const named = new Set(byName);
      return {
        from: token.from,
        options: matches.map((path) => ({
          label: baseName(path),
          detail: dirName(path),
          boost: named.has(path) ? 0 : -10,
          apply: (view: EditorView, _completion: Completion, from: number, to: number): void => {
            // The @token goes away; the file lands as a chip.
            view.dispatch({ changes: { from, to, insert: '' } });
            state.addFile(path);
          },
        })),
        validFor: /^@[^\s@]*$/u,
      } satisfies CompletionResult;
    });

  const sendQuestion = (): void => {
    const view = composerView;
    if (view === null) {
      return;
    }
    const question = view.state.doc.toString().trim();
    if (question === '') {
      return;
    }
    setComposerText('');
    void state.ask(question).then((sent) => {
      if (!sent) {
        setComposerText(question); // keep what the user typed when it failed
      }
    });
  };

  sendButton.addEventListener('click', sendQuestion);

  const setComposerText = (text: string): void => {
    const view = composerView;
    if (view === null) {
      return;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  };

  try {
    const EditorView = cm.view.EditorView;
    composerView = new EditorView({
      state: cm.state.EditorState.create({
        doc: '',
        extensions: [
          // The composer sits on a dark surface: mark the view dark so CM's
          // base theme switches the native caret from black ("&light") to
          // white ("&dark") -- otherwise the caret is invisible.
          EditorView.theme({}, { dark: true }),
          EditorView.lineWrapping,
          cm.view.placeholder('Ask anything …'),
          cm.view.keymap.of(cm.autocomplete.completionKeymap),
          cm.autocomplete.autocompletion({ override: [atFileSource] }),
          EditorView.domEventHandlers({
            paste: (event: DragEvent | ClipboardEvent) => stageFromEvent(event),
            drop: (event: DragEvent) => stageFromEvent(event),
          }) as Extension,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              sizeComposer();
            }
          }),
          cm.view.keymap.of([
            {
              key: 'Shift-Enter',
              run: (view) => {
                view.dispatch(view.state.replaceSelection('\n'));
                return true;
              },
            },
            {
              key: 'Enter',
              run: () => {
                sendQuestion();
                return true;
              },
            },
          ]),
        ],
      }),
      parent: composerHost,
    });
    sizeComposer();
  } catch {
    // Should not happen (the host always hands the modules over); the panel
    // still renders its thread without a composer.
  }

  // -- render loop -----------------------------------------------------------
  const render = (): void => {
    // The active chat's title: the live list wins (fresh after every
    // change round), the loaded view's frontmatter is the fallback for
    // a just-created chat the list has not re-read yet.
    const activePath = state.activeChatPath();
    const chatTitle =
      activePath === null
        ? null
        : (state.chats().find((chat) => chat.path === activePath)?.title ??
          state.view()?.frontmatter.title ??
          null);
    chatLabel.textContent = chatTitle ?? 'New chat';
    chatLabel.title = chatTitle ?? 'New chat';

    sendButton.disabled = state.asking();
    renderChips();
    renderThread();
  };
  render();
  const unsubState = state.subscribe(render);
  const unsubTasks = tasks.subscribe(render);

  return {
    cleanup: () => {
      unsubState();
      unsubTasks();
      resizeObserver.disconnect();
      composerView?.destroy();
      composerView = null;
    },
  };
}

/** First line of a tool result, for the chip's summary line. */
function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim() !== '') ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/** The Vault chip's tooltip: what the next ask searches (names when known). */
function vaultScopeTitle(state: AssistantState): string {
  const scope = state.vaultScope();
  if (scope === 'vault') {
    return 'Vault context: the most similar sections of the active vault. Click to change.';
  }
  if (scope === 'all') {
    return 'Vault context: the most similar sections across every vault. Click to change.';
  }
  if (scope === 'custom') {
    const byId = new Map(state.vaults().map((vault) => [vault.id, vault.name]));
    const ids = state.customVaultIds();
    const names = ids.map((id) => byId.get(id));
    const listed = names.every((name) => name !== undefined)
      ? (names as string[]).join(', ')
      : `${ids.length} vault${ids.length === 1 ? '' : 's'}`;
    return `Vault context: the most similar sections of ${listed}. Click to change.`;
  }
  return 'Vault context: pick which vaults the assistant searches — the active one, all of them, or a selection.';
}

/** Compact argument summary for a call chip. */
/** `mcp__<server>__<tool>` reads as "server · tool"; any other name as it is. */
function toolDisplayName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match !== null ? `${match[1]} · ${match[2]}` : name;
}

function summarizeArguments(args: unknown): string {
  if (typeof args === 'string') {
    const cleaned = args.replace(/^\{|\}$/g, '').trim();
    return cleaned === '' ? '' : cleaned;
  }
  if (args !== null && typeof args === 'object') {
    const parts = Object.entries(args as Record<string, unknown>).map(
      ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    );
    const joined = parts.join(', ');
    return joined.length > 48 ? `${joined.slice(0, 48)}…` : joined;
  }
  return '';
}

function formatArguments(args: unknown): string {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
