/**
 * The assistant panel's DOM (ADR-0044 rule 2: plugin UI is plain DOM). Port
 * of `src/app/assistant/note-assistant.{ts,html,css}` — the automatic
 * summary switch, the card thread, and the composer.
 *
 * Two deliberate divergences from the old Angular panel, both recorded in
 * the stage-7 notes:
 * - the composer is a bare host CodeMirror view (the host's instances via
 *   `api.editor.cm`), so the inline spellchecker (a base Angular service)
 *   does not run here;
 * - a manual Action's noop/error message shows as a quiet line in the panel
 *   (it used to sit in the editor meta bar, which is base UI).
 */
import type { Extension } from '@codemirror/state';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { ChatCard } from '../shared/chat-thread.js';
import type { AssistantState } from './state.js';
import type { RunningTasks } from './running-tasks.js';

const PREFS_KEY = 'drey.assistant';
/** The composer height used to live in the shell's `drey.layout` blob. */
const LEGACY_LAYOUT_KEY = 'drey.layout';
const COMPOSER = { min: 60, max: 400, def: 120 };

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

type IconName = 'check' | 'arrow-up' | 'copy' | 'corner-down-left' | 'rotate-ccw';

/** The five Lucide glyphs the panel uses (same paths as `src/app/icons/icon.ts`). */
const ICON_PATHS: Record<IconName, readonly string[]> = {
  check: ['M20 6 9 17l-5-5'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
  copy: [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  ],
  'corner-down-left': ['M20 4v7a4 4 0 0 1-4 4H4', 'm9 10-5 5 5 5'],
  'rotate-ccw': ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
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

function readComposerHeight(): number {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw !== null) {
      const saved = JSON.parse(raw) as { composerHeight?: number };
      if (typeof saved.composerHeight === 'number') {
        return clamp(saved.composerHeight);
      }
    }
    // One-time carry-over of the pre-conversion value.
    const legacy = localStorage.getItem(LEGACY_LAYOUT_KEY);
    if (legacy !== null) {
      const saved = JSON.parse(legacy) as { assistantComposerHeight?: number };
      if (typeof saved.assistantComposerHeight === 'number') {
        return clamp(saved.assistantComposerHeight);
      }
    }
  } catch {
    // Fall through to the default.
  }
  return COMPOSER.def;
}

function clamp(value: number): number {
  return Math.max(COMPOSER.min, Math.min(COMPOSER.max, Math.round(value)));
}

/** The slice of a host CodeMirror view the panel touches. */
interface ComposerView {
  destroy(): void;
  focus(): void;
  // Deliberately loose: the structural type must stay assignable from the
  // real EditorView, whose dispatch is overloaded.
  dispatch(tr: unknown): void;
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

  // -- header: the per-note automatic-summary switch -------------------------
  const switchButton = el('button', 'switch') as HTMLButtonElement;
  switchButton.type = 'button';
  switchButton.setAttribute('role', 'switch');
  switchButton.setAttribute('aria-labelledby', 'assistant-auto-summary-label');
  switchButton.appendChild(el('span', 'knob'));
  switchButton.addEventListener('click', () => state.setAutoSummary(!state.autoSummary()));

  const head = el('header', 'assistant-head');
  const switchLabel = el('span', 'toggle-label', 'Automatic summary');
  switchLabel.id = 'assistant-auto-summary-label';
  head.append(switchLabel, switchButton);
  body.appendChild(head);

  // -- thread ----------------------------------------------------------------
  const thread = el('div', 'assistant-thread');
  body.appendChild(thread);

  let confirmingRestart: string | null = null;
  let copiedCardId: string | null = null;

  const cardNode = (card: ChatCard): HTMLElement => {
    const article = el('article', 'card');
    article.classList.add(
      card.role === 'summary' ? 'summary' : card.role === 'question' ? 'q' : 'a',
    );

    const label = el('div', 'card-label');
    label.appendChild(
      document.createTextNode(
        card.role === 'summary' ? 'SUMMARY' : card.role === 'question' ? 'YOU' : 'ANSWER',
      ),
    );
    if (card.at !== '') {
      label.appendChild(el('span', 'at', ` · ${card.at.slice(11, 16)}`));
    }
    const took = state.took(card.durationMs);
    if (took !== null) {
      label.appendChild(el('span', 'took', ` · ${took}`));
    }
    article.appendChild(label);
    article.appendChild(el('p', 'card-body', card.text));

    if (confirmingRestart === card.id) {
      const confirm = el('div', 'card-confirm');
      const count = state.laterCount(card.id);
      confirm.appendChild(
        el('span', undefined, `Remove ${count} message${count === 1 ? '' : 's'}?`),
      );
      const restartBtn = el('button', undefined, 'Restart') as HTMLButtonElement;
      restartBtn.type = 'button';
      restartBtn.addEventListener('click', () => {
        confirmingRestart = null;
        void state.restartFrom(card.id).then((question) => {
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
      if (card.role === 'question') {
        const restart = el('button') as HTMLButtonElement;
        restart.type = 'button';
        restart.title = 'Restart chat from here';
        restart.disabled = tasks.isRunning();
        restart.appendChild(icon('rotate-ccw'));
        restart.addEventListener('click', () => {
          confirmingRestart = card.id;
          render();
        });
        actions.appendChild(restart);
      } else {
        const insert = el('button') as HTMLButtonElement;
        insert.type = 'button';
        insert.title = 'Insert into note';
        insert.disabled = state.notePath() === null;
        insert.appendChild(icon('corner-down-left'));
        insert.addEventListener('click', () => {
          api.documents.insertAtCursor(card.text);
        });
        actions.appendChild(insert);
      }
      const copy = el('button') as HTMLButtonElement;
      copy.type = 'button';
      copy.title = copiedCardId === card.id ? 'Copied' : 'Copy to clipboard';
      copy.replaceChildren(icon(copiedCardId === card.id ? 'check' : 'copy'));
      copy.addEventListener('click', () => {
        void navigator.clipboard
          .writeText(card.text)
          .then(() => {
            copiedCardId = card.id;
            render();
            setTimeout(() => {
              if (copiedCardId === card.id) {
                copiedCardId = null;
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
      return 'LLM features are off — nothing is summarised or answered.';
    }
    if (state.notePath() === null) {
      return 'Open a note to have it summarised.';
    }
    return state.autoSummary()
      ? 'Nothing summarised yet.'
      : 'Automatic summary is off for this note.';
  };

  const renderThread = (): void => {
    thread.textContent = '';
    const cards = state.cards();
    if (cards.length === 0 && !state.summarizing()) {
      thread.appendChild(el('p', 'empty', emptyStateText()));
    }
    for (const card of cards) {
      thread.appendChild(cardNode(card));
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
  };

  // -- composer --------------------------------------------------------------
  const composer = el('footer', 'assistant-composer');
  let composerHeight = readComposerHeight();
  composer.style.height = `${composerHeight}px`;

  const summarizeBtn = el('button', 'summarize', 'Summarise now') as HTMLButtonElement;
  summarizeBtn.type = 'button';
  summarizeBtn.addEventListener('click', () => void state.summarizeNow());

  const composerHost = el('div', 'composer-input');
  const sendButton = el('button', 'send') as HTMLButtonElement;
  sendButton.type = 'button';
  sendButton.setAttribute('aria-label', 'Send question');
  sendButton.appendChild(icon('arrow-up', 13));
  const box = el('div', 'composer-box');
  box.append(composerHost, sendButton);
  composer.append(summarizeBtn, box);
  body.appendChild(composer);

  // thread|composer drag handle, same gesture as the shell's dividers:
  // pointer capture on the handle keeps the drag alive outside the 1px line.
  const divider = el('div', 'assistant-divider');
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'horizontal');
  divider.setAttribute('aria-label', 'Resize composer');
  body.appendChild(divider);

  let dragging = false;
  divider.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    dragging = true;
    document.body.style.userSelect = 'none';
  });
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) {
      return;
    }
    const bottom = body.getBoundingClientRect().bottom;
    composerHeight = clamp(bottom - event.clientY);
    composer.style.height = `${composerHeight}px`;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ composerHeight }));
    } catch {
      // A non-persisted session is fine.
    }
  };
  const onPointerUp = (): void => {
    if (dragging) {
      dragging = false;
      document.body.style.userSelect = '';
    }
  };
  body.addEventListener('pointermove', onPointerMove);
  body.addEventListener('pointerup', onPointerUp);
  body.addEventListener('pointercancel', onPointerUp);

  // The composer is the host's CodeMirror in a minimal configuration:
  // Enter sends, Shift+Enter breaks the line (the old compact surface's
  // keymap behaviour). Editability rides a compartment so "no note open"
  // can flip it without rebuilding the view.
  const cm = api.editor.cm;
  let composerView: ComposerView | null = null;
  let editableCompartment: CompartmentLike | null = null;

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
    editableCompartment = new cm.state.Compartment();
    composerView = new EditorView({
      state: cm.state.EditorState.create({
        doc: '',
        extensions: [
          EditorView.lineWrapping,
          cm.view.placeholder('Ask about this note …'),
          editableCompartment.of(EditorView.editable.of(false)) as Extension,
          cm.view.keymap.of([
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
  } catch {
    // Should not happen (the host always hands the modules over); the panel
    // still renders its thread without a composer.
  }

  // -- render loop -----------------------------------------------------------
  const render = (): void => {
    const hasNote = state.notePath() !== null;
    switchButton.setAttribute('aria-checked', String(state.autoSummary()));
    switchButton.classList.toggle('on', state.autoSummary());
    switchButton.disabled = !hasNote;

    summarizeBtn.style.display = state.canSummarize() ? '' : 'none';
    summarizeBtn.disabled = state.summarizing();
    sendButton.disabled = state.asking();
    if (composerView !== null && editableCompartment !== null) {
      composerView.dispatch({
        effects: editableCompartment.reconfigure(cm.view.EditorView.editable.of(hasNote)),
      });
    }
    renderThread();
  };
  render();
  const unsubState = state.subscribe(render);
  const unsubTasks = tasks.subscribe(render);

  return {
    cleanup: () => {
      unsubState();
      unsubTasks();
      composerView?.destroy();
      composerView = null;
      body.removeEventListener('pointermove', onPointerMove);
      body.removeEventListener('pointerup', onPointerUp);
      body.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
