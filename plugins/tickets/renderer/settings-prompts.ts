import type { DreyPluginApi, MarkdownViewHandle } from '../../../shared/plugin-api/renderer';
import type { PromptEntry, PromptListing } from '../shared/tickets';
import { el, iconButton, mutate, textButton } from './settings-dom';

/**
 * Settings → Tickets, the prompts (req-50): exactly the files in
 * `tickets/_meta/prompts/` — no rows for prompts the folder lacks, no
 * comparison with code. A list of the files left, the selected one in the
 * host's Markdown editor right (`ui.createMarkdownView`, Live Preview).
 * Saved when the editor is left or on Save — one commit per save.
 * A refresh that finds the file changed on disk loads it silently when
 * nothing is unsaved, and asks otherwise.
 */

const PROMPT_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface PromptsSection {
  readonly root: HTMLElement;
  /** New disk state plus which columns use which prompt. */
  update(listing: PromptListing, usage: ReadonlyMap<string, readonly string[]>): void;
  /** Saves unsaved text and releases the editor (page unmount). */
  dispose(): void;
}

export function createPromptsSection(api: DreyPluginApi, reload: () => Promise<void>): PromptsSection {
  const root = el('section', 'tset-section');
  root.setAttribute('aria-labelledby', 'tset-prompts-head');

  const head = el('div', 'tset-section-head');
  const title = el('h3', undefined, 'Prompts');
  title.id = 'tset-prompts-head';
  const count = el('span', 'tset-muted');
  const newBtn = iconButton(api, 'plus', 'New prompt');
  const folderBtn = iconButton(api, 'folder', 'Open the prompts folder');
  const reloadBtn = iconButton(api, 'refresh-cw', 'Reload from disk');
  // Visible when the folder holds files but lacks shipped ones (req-72):
  // the empty state has its own button, this one covers the seeded-long-ago
  // vault that never saw a prompt Drey later shipped.
  const restoreBtn = textButton("Add Drey's prompts", 'primary');
  restoreBtn.hidden = true;
  restoreBtn.addEventListener('click', () => {
    restoreBtn.disabled = true;
    void mutate(api, 'promptRestore').then(async (result) => {
      restoreBtn.disabled = false;
      if (!result.ok) {
        setFoot(result.error ?? 'Not added', true);
      }
      await reload();
    });
  });
  const tools = el('span', 'tset-head-tools');
  tools.append(restoreBtn, newBtn, folderBtn, reloadBtn);
  head.append(title, count, tools);

  const hint = el('p', 'section-hint');
  const body = el('div', 'tset-prompts');
  const list = el('div', 'tset-plist');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Prompt files');
  const detail = el('div', 'tset-pdetail');
  body.append(list, detail);
  root.append(head, hint, body);

  let listing: PromptListing = { folder: null, entries: [], shipped: [] };
  let usage: ReadonlyMap<string, readonly string[]> = new Map();
  let selected: string | null = null;
  let view: MarkdownViewHandle | null = null;
  let saved = '';
  let inflight: Promise<boolean> | null = null;
  let diskText: string | null = null; // set while a changed-on-disk notice is open

  // Detail parts, rebuilt per selection.
  const bar = el('div', 'tset-pbar');
  const notice = el('div', 'callout warn tset-notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const editorHost = el('div', 'tset-editor');
  const foot = el('div', 'tset-pfoot');
  foot.setAttribute('aria-live', 'polite');
  let saveBtn: HTMLButtonElement | null = null;
  let revertBtn: HTMLButtonElement | null = null;
  let stateText: HTMLElement | null = null;

  const dirty = (): boolean => view !== null && view.getContent() !== saved;

  const syncBar = (): void => {
    const isDirty = dirty();
    if (saveBtn !== null) {
      saveBtn.hidden = !isDirty;
    }
    if (revertBtn !== null) {
      revertBtn.hidden = !isDirty;
    }
    if (stateText !== null) {
      stateText.textContent = isDirty ? 'Unsaved changes' : '';
    }
  };

  const setFoot = (text: string, error = false): void => {
    foot.textContent = text;
    foot.classList.toggle('tset-error', error);
  };

  // One save at a time; a second caller (focus-out, then a list click)
  // waits for the one in flight instead of reporting "unsaved".
  const save = (): Promise<boolean> => {
    if (inflight !== null) {
      return inflight;
    }
    if (selected === null || view === null || !dirty()) {
      return Promise.resolve(true);
    }
    inflight = saveNow(selected, view.getContent()).finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const saveNow = async (ref: string, text: string): Promise<boolean> => {
    setFoot('Saving…');
    const result = await mutate(api, 'promptSave', { ref, text });
    if (!result.ok) {
      setFoot(`Not saved: ${result.error ?? 'the write failed'}`, true);
      return false;
    }
    if (selected === ref) {
      saved = text;
      syncBar();
    }
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    setFoot(`Saved ${time} · tickets: prompt ${ref} edit${result.warning !== undefined ? ` — ${result.warning}` : ''}`);
    return true;
  };

  const releaseView = (): void => {
    view?.dispose();
    view = null;
  };

  const showDetail = (entry: PromptEntry | null): void => {
    releaseView();
    detail.replaceChildren();
    notice.hidden = true;
    diskText = null;
    setFoot('');
    if (entry === null) {
      return;
    }
    saved = entry.text;
    bar.replaceChildren();
    const name = el('span', 'tset-pname', `${entry.ref}.md`);
    const used = usage.get(entry.ref) ?? [];
    const chip = el('span', 'tset-chip tset-chip-manual', used.length > 0 ? `Used by ${used.join(', ')}` : 'Not used by a column');
    stateText = el('span', 'tset-muted tset-pstate');
    revertBtn = iconButton(api, 'rotate-ccw', 'Discard unsaved changes');
    revertBtn.addEventListener('click', () => {
      view?.setContent(saved);
      syncBar();
      setFoot('Changes discarded');
    });
    bar.append(name, chip, stateText, revertBtn);
    if (entry.shipped) {
      const reset = iconButton(api, 'history', 'Reset to the shipped version');
      reset.addEventListener('click', () => confirmReset(entry.ref));
      bar.append(reset);
    }
    saveBtn = textButton('Save', 'primary');
    saveBtn.addEventListener('click', () => void save());
    bar.append(saveBtn);

    view = api.ui.createMarkdownView({ content: lf(entry.text), mode: 'live', onChange: () => syncBar() });
    // The editor's own reading of the file is the clean state (it holds LF).
    saved = view.getContent();
    editorHost.replaceChildren(view.element);
    view.element.setAttribute('aria-label', `Text of ${entry.ref}.md`);
    detail.append(bar, notice, editorHost, foot);
    syncBar();
  };

  // Leaving the editor saves. (Ctrl+S cannot be offered: the app's
  // keybinding layer takes it at window capture before a page sees it.)
  editorHost.addEventListener('focusout', (event) => {
    if (!editorHost.contains(event.relatedTarget as Node | null)) {
      void save();
    }
  });

  const confirmReset = (ref: string): void => {
    bar.replaceChildren(
      el('span', 'tset-pname', `${ref}.md`),
      el('span', 'tset-muted tset-pstate', 'Replace the text with the version Drey ships?'),
    );
    const cancel = textButton('Cancel');
    const confirm = textButton('Reset', 'primary');
    cancel.addEventListener('click', () => showDetail(listing.entries.find((e) => e.ref === ref) ?? null));
    confirm.addEventListener('click', () => {
      void mutate(api, 'promptSave', { ref, reset: true }).then(async (result) => {
        if (!result.ok) {
          setFoot(`Not reset: ${result.error ?? ''}`, true);
          return;
        }
        // The reset replaces whatever was unsaved: load the new disk text as is.
        saved = '';
        await reload();
        const fresh = listing.entries.find((e) => e.ref === ref) ?? null;
        showDetail(fresh);
        setFoot('Reset to the shipped version · your text stays in the git history');
      });
    });
    bar.append(cancel, confirm);
    foot.textContent = 'Your current text stays in the git history.';
  };

  const select = async (ref: string): Promise<void> => {
    if (ref === selected) {
      return;
    }
    if (dirty() && !(await save())) {
      return; // a failed save keeps the editor where it is
    }
    selected = ref;
    renderList();
    showDetail(listing.entries.find((e) => e.ref === ref) ?? null);
  };

  const renderList = (): void => {
    list.replaceChildren();
    for (const entry of listing.entries) {
      const item = el('button', `tset-pitem${entry.ref === selected ? ' tset-pitem-on' : ''}`);
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(entry.ref === selected));
      const used = usage.get(entry.ref) ?? [];
      item.append(
        el('span', 'tset-pitem-name', `${entry.ref}.md`),
        el('span', 'tset-pitem-used', used.length > 0 ? used.join(', ') : 'Not used by a column'),
      );
      item.addEventListener('click', () => void select(entry.ref));
      list.append(item);
    }
  };

  const renderEmpty = (): void => {
    releaseView();
    detail.replaceChildren();
    const empty = el('div', 'tset-pempty');
    empty.append(
      el('span', undefined, 'No files in tickets/_meta/prompts/'),
      el('span', 'tset-muted', 'A column that runs itself needs one. Add the prompts Drey ships, or create your own.'),
    );
    const actions = el('div', 'tset-actions');
    if (listing.shipped.length > 0) {
      const add = textButton("Add Drey's prompts", 'primary');
      add.addEventListener('click', () => {
        add.disabled = true;
        void mutate(api, 'promptRestore').then(async (result) => {
          add.disabled = false;
          if (!result.ok) {
            setFoot(result.error ?? 'Not added', true);
          }
          await reload();
        });
      });
      actions.append(add);
    }
    const create = textButton('New prompt');
    create.addEventListener('click', () => openNewForm());
    actions.append(create);
    empty.append(actions);
    detail.append(empty);
  };

  const openNewForm = (): void => {
    if (list.querySelector('.tset-newprompt') !== null) {
      list.querySelector('input')?.focus();
      return;
    }
    const form = el('div', 'tset-newprompt');
    const label = el('label', 'tset-muted', 'Name');
    const input = el('input', 'mono-input');
    input.id = 'tset-newprompt-name';
    label.htmlFor = input.id;
    input.type = 'text';
    input.spellcheck = false;
    const suffix = el('span', 'tset-muted', '.md');
    const create = textButton('Create', 'primary');
    const cancel = iconButton(api, 'x', 'Cancel');
    const message = el('span', 'tset-muted tset-newprompt-hint', 'Letters, digits, dot, dash, underscore.');
    const row = el('div', 'tset-newprompt-row');
    row.append(label, input, suffix, create, cancel);
    form.append(row, message);
    list.prepend(form);
    input.focus();
    const close = (): void => form.remove();
    const submit = async (): Promise<void> => {
      const ref = input.value.trim().replace(/\.md$/i, '');
      if (!PROMPT_REF.test(ref)) {
        message.textContent = 'Letters, digits, dot, dash and underscore only.';
        message.classList.add('tset-error');
        return;
      }
      if (listing.entries.some((e) => e.ref === ref)) {
        message.textContent = 'A prompt of that name exists.';
        message.classList.add('tset-error');
        return;
      }
      const result = await mutate(api, 'promptSave', { ref, text: '# Instructions\n\n' });
      if (!result.ok) {
        message.textContent = result.error ?? 'Could not create the prompt.';
        message.classList.add('tset-error');
        return;
      }
      close();
      await reload();
      await select(ref);
      view?.focus();
    };
    create.addEventListener('click', () => void submit());
    cancel.addEventListener('click', close);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });
  };

  newBtn.addEventListener('click', () => openNewForm());
  folderBtn.addEventListener('click', () => void mutate(api, 'openFolder', { which: 'prompts' }));
  reloadBtn.addEventListener('click', () => void reload());

  return {
    root,
    update: (nextListing, nextUsage) => {
      listing = nextListing;
      usage = nextUsage;
      const n = listing.entries.length;
      count.textContent = n === 1 ? '1 file' : `${n} files`;
      hint.textContent =
        `The files in ${listing.folder ?? 'tickets/_meta/prompts/'}, as they are on disk. ` +
        'Saved when you leave the editor or press Save, one commit per save. A change reaches the next run, not one already running.';
      folderBtn.disabled = listing.folder === null;
      const missing = listing.shipped.filter((ref) => !listing.entries.some((e) => e.ref === ref));
      restoreBtn.hidden = n === 0 || missing.length === 0;
      restoreBtn.textContent =
        missing.length === listing.shipped.length
          ? "Add Drey's prompts"
          : `Add Drey's prompts (${missing.length} missing)`;
      restoreBtn.title = missing.length > 0 ? `Adds ${missing.map((m) => `${m}.md`).join(', ')}` : '';
      if (n === 0) {
        selected = null;
        list.replaceChildren();
        renderEmpty();
        return;
      }
      const found = selected === null ? undefined : listing.entries.find((e) => e.ref === selected);
      const current = found === undefined ? undefined : { ...found, text: lf(found.text) };
      if (current === undefined) {
        // First load, or the selected file is gone from disk.
        selected = listing.entries[0]!.ref;
        renderList();
        showDetail(listing.entries[0]!);
        return;
      }
      renderList();
      if (current.text === saved || view === null || inflight !== null) {
        return;
      }
      if (current.text === view.getContent()) {
        // Our own save's echo, or the disk caught up with the editor.
        saved = current.text;
        syncBar();
        return;
      }
      if (!dirty()) {
        saved = current.text;
        view.setContent(current.text);
        setFoot('Reloaded from disk');
        return;
      }
      if (diskText === current.text) {
        return;
      }
      diskText = current.text;
      notice.replaceChildren(el('span', undefined, 'The file changed outside Drey. Your unsaved text stays until you choose.'));
      const load = textButton('Load from disk');
      load.addEventListener('click', () => {
        saved = current.text;
        view?.setContent(current.text);
        notice.hidden = true;
        diskText = null;
        syncBar();
        setFoot('Loaded from disk');
      });
      notice.append(load);
      notice.hidden = false;
    },
    dispose: () => {
      if (dirty()) {
        void save().finally(releaseView);
      } else {
        releaseView();
      }
    },
  };
}

/** The editor holds LF; a CRLF checkout of the same text is not a change. */
function lf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
