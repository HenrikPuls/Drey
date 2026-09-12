/**
 * The assistant panel's DOM (ADR-0044 rule 2: plugin UI is plain DOM). Port
 * of `src/app/assistant/note-assistant.{ts,html,css}` — the automatic
 * summary switch, the card thread, and the composer.
 *
 * Milestone 24 composer, modelled on the Claude Code input: context chips
 * above the input (the open note by default, extra files via @-completion
 * or the "+" picker), an auto-growing text area (one line up to a cap,
 * then it scrolls inside — no drag divider any more), and a model row that
 * opens a picker for the globally configured model.
 *
 * Deliberate divergences from the old Angular panel, recorded in the
 * stage-7 notes and kept here:
 * - the composer is a bare host CodeMirror view (the host's instances via
 *   `api.editor.cm`), so the inline spellchecker (a base Angular service)
 *   does not run here;
 * - a manual Action's noop/error message shows as a quiet line in the panel
 *   (it used to sit in the editor meta bar, which is base UI).
 * - the @-completion opens on a bare `@` (the wikilink source waits for an
 *   explicit request): in a one-line composer the popup IS the affordance.
 */
import type { Extension } from '@codemirror/state';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { ChatCard } from '../shared/chat-thread.js';
import type { AssistantState } from './state.js';
import type { RunningTasks } from './running-tasks.js';
import { createVaultFileCache, type VaultFileCache } from './vault-files.js';

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
  // Claude-Code-style: context chips on top (the note by default, files
  // added via @ or the + picker), an auto-growing input, and a meta row
  // with the model picker. The height follows the content — no divider.
  const composer = el('footer', 'assistant-composer');
  const chipsRow = el('div', 'composer-chips');
  const composerHost = el('div', 'composer-input');
  const sendButton = el('button', 'send') as HTMLButtonElement;
  sendButton.type = 'button';
  sendButton.setAttribute('aria-label', 'Send question');
  sendButton.appendChild(icon('arrow-up', 13));
  const plusButton = el('button', 'plus', '+') as HTMLButtonElement;
  plusButton.type = 'button';
  plusButton.title = 'Add a file to the context';
  plusButton.setAttribute('aria-label', 'Add a file to the context');
  const row = el('div', 'composer-row');
  row.append(plusButton, composerHost, sendButton);
  const modelButton = el('button', 'model-btn', '…') as HTMLButtonElement;
  modelButton.type = 'button';
  modelButton.title = 'Pick the model';
  modelButton.setAttribute('aria-label', 'Pick the model');
  const summarizeBtn = el('button', 'summarize', 'Summarise now') as HTMLButtonElement;
  summarizeBtn.type = 'button';
  summarizeBtn.addEventListener('click', () => void state.summarizeNow());
  const meta = el('div', 'composer-meta');
  meta.append(modelButton, summarizeBtn);
  const box = el('div', 'composer-box');
  box.append(chipsRow, row);
  composer.append(box, meta);
  body.appendChild(composer);

  const chipNode = (path: string, isNote: boolean): HTMLElement => {
    const chip = el('span', isNote ? 'chip note' : 'chip');
    chip.title = path;
    chip.appendChild(el('span', 'chip-name', baseName(path)));
    const remove = el('button', 'chip-x', '×') as HTMLButtonElement;
    remove.type = 'button';
    remove.title = isNote ? 'Exclude this note from the context' : 'Remove from the context';
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => {
      if (isNote) {
        state.setNoteIncluded(false);
      } else {
        state.removeFile(path);
      }
    });
    chip.appendChild(remove);
    return chip;
  };

  const renderChips = (): void => {
    chipsRow.textContent = '';
    const path = state.notePath();
    if (path !== null && state.noteIncluded()) {
      chipsRow.appendChild(chipNode(path, true));
    }
    for (const file of state.extraFiles()) {
      chipsRow.appendChild(chipNode(file, false));
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
  refreshModelLabel();

  // -- the two pickers (api.ui.showModal; same gesture as the templates picker) --

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

  function openFilePicker(): void {
    let close: () => void = () => undefined;
    let filter = '';
    let activeIndex = 0;
    let files: readonly string[] = [];
    const notePath = state.notePath();

    const box = el('div', 'assistant-picker');
    const headLabel = el('div', 'assistant-picker-head', 'Attach a file');
    const bodyArea = el('div', 'assistant-picker-body');
    box.append(headLabel, bodyArea);

    const filterInput = el('input', 'assistant-picker-input') as HTMLInputElement;
    filterInput.type = 'text';
    filterInput.placeholder = 'Filter files …';
    const listBox = el('div', 'assistant-picker-list');
    bodyArea.append(filterInput, listBox);

    const visibleFiles = (): readonly string[] => {
      const query = filter.trim().toLowerCase();
      return files.filter((path) => {
        if (path === notePath && state.noteIncluded()) {
          return false; // already attached as the note chip
        }
        if (query === '') {
          return true;
        }
        const base = baseName(path).toLowerCase();
        return base.startsWith(query) || path.toLowerCase().includes(query);
      });
    };

    const choose = (path: string): void => {
      const result = state.addFile(path);
      if (result.ok) {
        close();
      }
    };

    const renderList = (): void => {
      listBox.textContent = '';
      const visible = visibleFiles();
      if (activeIndex >= visible.length) {
        activeIndex = Math.max(0, visible.length - 1);
      }
      visible.forEach((path, index) => {
        const rowEl = el(
          'div',
          'assistant-picker-row' + (index === activeIndex ? ' active' : ''),
          baseName(path),
        );
        if (path === notePath && !state.noteIncluded()) {
          rowEl.classList.add('this-note');
        }
        const dir = dirName(path);
        if (dir !== '') {
          rowEl.appendChild(el('span', 'assistant-picker-detail', dir));
        }
        rowEl.title = path;
        rowEl.addEventListener('click', () => choose(path));
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
            files.length === 0 ? 'No markdown files in the vault.' : 'No matching file',
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
        const len = visibleFiles().length;
        if (len > 0) {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          activeIndex = (activeIndex + delta + len) % len;
          renderList();
        }
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const path = visibleFiles()[activeIndex];
        if (path !== undefined) {
          choose(path);
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
  }

  // The panel's own view of the vault files (the @ source and the picker).
  const vaultFiles: VaultFileCache = createVaultFileCache(api);

  // -- the CodeMirror composer -------------------------------------------------
  // The host's CodeMirror in a minimal configuration: @-completion over the
  // vault files (a pick deletes the @token and adds a chip instead of
  // inserting text), Enter sends, Shift+Enter breaks the line. The
  // completion keymap sits BEFORE the send binding, so Enter accepts an
  // open completion and only sends when none is active. Editability rides
  // a compartment so "no note open" can flip it without rebuilding.
  const cm = api.editor.cm;
  let composerView: ComposerView | null = null;
  let editableCompartment: CompartmentLike | null = null;

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
    editableCompartment = new cm.state.Compartment();
    composerView = new EditorView({
      state: cm.state.EditorState.create({
        doc: '',
        extensions: [
          EditorView.lineWrapping,
          cm.view.placeholder('Ask anything …'),
          editableCompartment.of(EditorView.editable.of(false)) as Extension,
          cm.view.keymap.of(cm.autocomplete.completionKeymap),
          cm.autocomplete.autocompletion({ override: [atFileSource] }),
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
