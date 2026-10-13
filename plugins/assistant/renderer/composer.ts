/**
 * The assistant panel's composer, Claude-Code-style: context chips on top
 * (the note by default, files via @ or the + picker, images via the
 * picker's Images tab or paste/drop), an auto-growing input, and a meta
 * row with the tool buttons and the model picker.
 *
 * The input is a bare host CodeMirror view (the host's instances via
 * `api.editor.cm`), so the inline spellchecker (a base Angular service)
 * does not run here.
 */
import type { Extension } from '@codemirror/state';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { STAGE_IMAGE_EXTENSIONS } from '../shared/stage.js';
import { createStager } from './composer-staging.js';
import { baseName, dirName, el, icon } from './dom.js';
import { openFilePicker } from './picker-file.js';
import { createModelSetting, openModelPicker } from './picker-model.js';
import { openPromptPicker } from './picker-prompt.js';
import { openVaultPicker } from './picker-vault.js';
import type { AssistantState } from './state.js';
import { vaultScopeTitle } from './tool-format.js';
import { createVaultFileCache, type VaultFileCache } from './vault-files.js';

/** The slice of a host CodeMirror view the composer touches. */
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

export interface Composer {
  /** Re-reads the send button's state, the tool toggles and the context chips. */
  render(): void;
  setText(text: string): void;
  focus(): void;
  destroy(): void;
}

/**
 * Builds the composer at the end of `panel` (the panel body). It is mounted
 * before the editor view is created, so CodeMirror measures a live
 * element; the input grows up to a share of the panel's height.
 */
export function mountComposer(
  panel: HTMLElement,
  api: DreyPluginApi,
  state: AssistantState,
): Composer {
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
  promptsButton.title = 'Prompts: pick one from the prompts folder';
  promptsButton.setAttribute('aria-label', 'Pick a prompt');
  const meta = el('div', 'composer-meta');
  meta.append(plusButton, liveButton, vaultButton, promptsButton, modelButton);
  const box = el('div', 'composer-box');
  box.append(chipsRow, row);
  composer.append(box, meta);
  panel.appendChild(composer);

  // The composer's own views of the vault (the @ source and the pickers).
  const vaultFiles: VaultFileCache = createVaultFileCache(api, '.md');
  const vaultImages: VaultFileCache = createVaultFileCache(api, ...STAGE_IMAGE_EXTENSIONS);

  let composerView: ComposerView | null = null;

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
    Math.max(88, Math.min(300, Math.round(panel.clientHeight * 0.4)));
  const sizeComposer = (): void => {
    const view = composerView;
    if (view === null) {
      return;
    }
    composerHost.style.height = `${Math.round(Math.min(view.contentHeight, composerCap()))}px`;
  };
  const resizeObserver = new ResizeObserver(() => sizeComposer());
  resizeObserver.observe(panel);

  const setText = (text: string): void => {
    const view = composerView;
    if (view === null) {
      return;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  };

  /** A picked prompt REPLACES the composer's text, ready to review and send. */
  const insertPrompt = (body: string): void => {
    const view = composerView;
    if (view === null) {
      return;
    }
    setText(body);
    sizeComposer();
    view.focus();
  };

  // -- the model row -----------------------------------------------------------
  const model = createModelSetting(api, () => {
    const current = model.current();
    modelButton.textContent = current === undefined ? '…' : (current ?? 'No model set');
  });

  modelButton.addEventListener('click', () => openModelPicker(api, model));
  plusButton.addEventListener('click', () => openFilePicker(api, state, vaultFiles, vaultImages));
  liveButton.addEventListener('click', () => state.toggleLiveEdit());
  vaultButton.addEventListener('click', () => openVaultPicker(api, state));
  promptsButton.addEventListener('click', () => void openPromptPicker(api, vaultFiles, insertPrompt));
  model.refresh();

  // -- the CodeMirror composer -------------------------------------------------
  // The host's CodeMirror in a minimal configuration: @-completion over the
  // vault files (a pick deletes the @token and adds a chip instead of
  // inserting text), Enter sends, Shift+Enter breaks the line. The
  // completion keymap sits BEFORE the send binding, so Enter accepts an
  // open completion and only sends when none is active. The composer is
  // always editable — a standalone chat needs no open note.
  const cm = api.editor.cm;

  // The @-completion opens on a bare `@`: in a one-line composer the popup
  // IS the affordance, there is no room for a "press Mod-Space" hint.
  const atFileSource = (context: CompletionContext): Promise<CompletionResult | null> =>
    vaultFiles.ensureLoaded().then((files) => {
      const token = context.matchBefore(/@[^\s@]*/);
      if (token === null) {
        return null;
      }
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
    setText('');
    void state.ask(question).then((sent) => {
      if (!sent) {
        setText(question); // keep what the user typed when it failed
      }
    });
  };

  sendButton.addEventListener('click', sendQuestion);

  const stageFromEvent = createStager(api, state);

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

  return {
    render: () => {
      sendButton.disabled = state.asking();
      renderChips();
    },
    setText,
    focus: () => composerView?.focus(),
    destroy: () => {
      resizeObserver.disconnect();
      composerView?.destroy();
      composerView = null;
    },
  };
}
