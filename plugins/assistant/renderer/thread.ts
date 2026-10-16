/**
 * The assistant panel's thread: turn cards rendered from the active chat
 * note (tool calls/results and edit outcomes as collapsible chips, a
 * `tasks_list` result as a task block, the retrieved vault context), the
 * streaming partial card, and the working / notice / error lines below.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { ChatNoteTurn, ChatToolEntry } from '../shared/chat-note.js';
import { baseName, el, icon } from './dom.js';
import { renderRichBody } from './rich-text.js';
import type { RunningTasks } from './running-tasks.js';
import type { AssistantState } from './state.js';
import { taskListNode } from './task-block.js';
import {
  TASKS_LIST_TOOL,
  firstLine,
  formatArguments,
  parseTasksResult,
  runningToolLabel,
  summarizeArguments,
  taskFilterLabelParts,
  toolDisplayName,
} from './tool-format.js';

export interface ThreadView {
  readonly node: HTMLElement;
  render(): void;
}

/**
 * `onRestarted` receives the question of the turn a chat was restarted
 * from, so the composer can offer it again.
 */
export function createThread(
  api: DreyPluginApi,
  state: AssistantState,
  tasks: RunningTasks,
  onRestarted: (question: string) => void,
): ThreadView {
  const thread = el('div', 'assistant-thread');

  let confirmingRestart: number | null = null;
  let copiedTurnIndex: number | null = null;
  /** Expanded tool-chip bodies, keyed `${turnIndex}:${i}` (session state). */
  const expandedChips = new Set<string>();

  const toggleChip = (key: string): void => {
    if (expandedChips.has(key)) {
      expandedChips.delete(key);
    } else {
      expandedChips.add(key);
    }
    render();
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
    summary.addEventListener('click', () => toggleChip(key));
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

  /**
   * A `tasks_list` call + result as the interactive task block instead of
   * two chips. Returns the block and the index of the paired result (the
   * caller skips it), or null when the entry is not such a pair or the
   * result is unparseable -- then the plain chips show (raw data over a
   * broken widget).
   */
  const taskBlockFor = (
    turn: ChatNoteTurn,
    i: number,
  ): { node: HTMLElement; resultIndex: number } | null => {
    const entry = turn.tool[i];
    if (entry.kind !== 'call' || entry.name !== TASKS_LIST_TOOL) {
      return null;
    }
    const resultIndex = turn.tool.findIndex((e) => e.kind === 'result' && e.id === entry.id);
    const result = resultIndex >= 0 ? turn.tool[resultIndex] : undefined;
    if (result === undefined || result.kind !== 'result') {
      return null;
    }
    const { records, truncated } = parseTasksResult(result.content);
    // A filtered query can legitimately match nothing — the provider's
    // exact empty marker renders as an empty block (with its filter
    // chips) instead of falling back to chips.
    if (records.length > 0 || truncated > 0 || result.content.trim() === 'No tasks found.') {
      return {
        node: taskListNode(
          api,
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
        resultIndex,
      };
    }
    // The pair exists but parsed to nothing — surface WHY in the console
    // instead of silently degrading to raw chips.
    console.warn(
      `[assistant] tasks_list result did not parse to records (first 120 chars): ${result.content.slice(0, 120)}`,
    );
    return null;
  };

  /**
   * Vault-context citations (ADR-0072): one collapsible chip listing
   * what this turn was given; a click opens the source file. A chip-on
   * turn with NO hits still gets a chip — the persisted contextStatus
   * says why (nothing found / not available / failed) instead of silent
   * nothing.
   */
  const contextChipNode = (turn: ChatNoteTurn, index: number): HTMLElement => {
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
      summary.appendChild(el('span', undefined, 'vault context · no matching sections'));
    } else if (status.kind === 'unavailable' || status.kind === 'disabled') {
      chip.classList.add('muted');
      summary.appendChild(el('span', undefined, 'vault context · not available'));
    } else if (status.kind === 'unregistered') {
      chip.classList.add('muted');
      summary.appendChild(
        el('span', undefined, 'vault context · the selected vaults are no longer registered'),
      );
    } else {
      chip.classList.add('muted');
      summary.appendChild(el('span', undefined, `vault context failed · ${firstLine(status.message)}`));
    }
    summary.addEventListener('click', () => toggleChip(key));
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
      } else {
        const hint = el('div', 'context-hint');
        if (status.kind === 'empty') {
          hint.textContent =
            'No note section contains the words of the question. A model that can call tools searches the vault further by itself.';
        } else if (status.kind === 'unavailable') {
          hint.textContent =
            'The Vault chip was on, but the section index was not available. Enable the Tags plugin under Settings → Panels & plugins.';
        } else if (status.kind === 'disabled') {
          hint.textContent = 'The Vault chip was on, but vault retrieval was switched off at the time.';
        } else if (status.kind === 'unregistered') {
          hint.textContent =
            'The vault selection referenced vaults that are no longer registered. Pick the vaults again with the Vault chip.';
        } else {
          hint.textContent = status.message;
        }
        list.appendChild(hint);
      }
      chip.appendChild(list);
    }
    return chip;
  };

  /** The "Remove N messages?" row a restart asks with. */
  const restartConfirmNode = (index: number): HTMLElement => {
    const confirm = el('div', 'card-confirm');
    const count = state.laterCount(index);
    confirm.appendChild(el('span', undefined, `Remove ${count} message${count === 1 ? '' : 's'}?`));
    const restartBtn = el('button', undefined, 'Restart') as HTMLButtonElement;
    restartBtn.type = 'button';
    restartBtn.addEventListener('click', () => {
      confirmingRestart = null;
      void state.restartFrom(index).then((question) => {
        if (question !== null) {
          onRestarted(question);
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
    return confirm;
  };

  /** A card's icon row: restart (question) or insert (answer), then copy. */
  const cardActionsNode = (turn: ChatNoteTurn, index: number): HTMLElement => {
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
    return actions;
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
      const block = taskBlockFor(turn, i);
      if (block !== null) {
        article.appendChild(block.node);
        if (block.resultIndex > i) {
          i = block.resultIndex; // resume after the paired result
        }
        continue;
      }
      article.appendChild(toolChipNode(turn.tool[i], `${index}:${i}`));
    }

    if (turn.context.length > 0 || turn.contextStatus !== null) {
      article.appendChild(contextChipNode(turn, index));
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

    article.appendChild(
      confirmingRestart === index ? restartConfirmNode(index) : cardActionsNode(turn, index),
    );
    return article;
  };

  const emptyStateText = (): string => {
    if (!api.llm.enabled()) {
      return 'LLM features are off — nothing is answered.';
    }
    return 'New chat — ask anything. A note or file chip gives it context.';
  };

  const dismissibleLine = (className: string, text: string, dismiss: () => void): HTMLElement => {
    const line = el('p', className, text);
    line.title = 'Dismiss';
    line.addEventListener('click', dismiss);
    return line;
  };

  function render(): void {
    // Stick-to-bottom (req: the transcript follows the streamed text):
    // remember whether the user is pinned to the bottom BEFORE the rebuild
    // wipes the children -- scrolling up unpins until they return to the
    // bottom. Pinned is the default (also for the empty first render).
    const pinned =
      thread.clientHeight === 0 ||
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 24;
    thread.textContent = '';

    const turns = state.view()?.turns ?? [];
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
      // The tool calls made so far, as they happen (ADR-0071): the same
      // chips the finished turn shows, not yet expandable.
      for (const tool of streaming.tools) {
        const chip = el('div', `tool-chip running ${tool.state}`);
        const summary = el('div', 'tool-chip-summary');
        summary.appendChild(icon('wrench', 10));
        summary.appendChild(el('span', undefined, runningToolLabel(tool)));
        chip.appendChild(summary);
        partial.appendChild(chip);
      }
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
      thread.appendChild(dismissibleLine('notice', notice, () => state.dismiss()));
    }
    const error = state.error();
    if (error !== null) {
      thread.appendChild(dismissibleLine('err', error, () => state.dismiss()));
    }
    const actionMessage = state.actionMessage();
    if (actionMessage !== null) {
      thread.appendChild(
        dismissibleLine('err notice', actionMessage, () => state.dismissActionMessage()),
      );
    }

    if (pinned) {
      thread.scrollTop = thread.scrollHeight;
    }
  }

  return { node: thread, render };
}
