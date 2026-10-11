import type {
  ContextMenuItem,
  DreyPluginApi,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import type { SnippetConfig } from '../../../shared/config/schema';
import { TemplateLibrary, type TemplateCategory, type TemplateEntry } from './library.js';
import { substitutePlaceholders } from '../../../shared/placeholders';
import { formatDate, formatDateTime, formatTime } from '../../../shared/timestamp';
import { stripFrontmatter } from './pure.js';
import { previewCard, templateSlashExtension } from './slash.js';
import { SNIPPET_DEFAULTS, SnippetStore, expandForPreview, snippetExtension } from './snippets.js';

/** The DataTransfer type template rows set on dragstart (drop side: our decoder). */
const TEMPLATE_DT_TYPE = 'application/x-drey-template';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

function button(className: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className) as HTMLButtonElement;
  node.type = 'button';
  node.title = title;
  node.addEventListener('click', onClick);
  return node;
}

/**
 * The Templates plugin (ADR-0029, converted in ADR-0044 stage 3): the vault
 * template library as a dock panel + `Mod+T` picker + drag-into-editor +
 * recent-template context-menu items + its own Settings page. Ported from
 * `src/app/templates/` — same behaviour, plain DOM instead of Angular.
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    const library = new TemplateLibrary(api);
    void library.reload();
    api.vault.onChanged(() => void library.reload());

    // -- editor snippets (milestone 46) ---------------------------------------
    const snippets = new SnippetStore(api);
    void snippets.load();

    // -- panel ---------------------------------------------------------------
    api.ui.registerWidget({
      id: 'templates',
      title: 'Templates',
      icon: 'file-text',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 200,
      headerActions: (actions) => {
        const refresh = button('icon-btn', 'Re-read the templates from disk', () =>
          void library.reload(),
        );
        refresh.setAttribute('aria-label', 'Refresh templates');
        refresh.appendChild(api.ui.icon('refresh-cw', 14));
        actions.appendChild(refresh);
        return () => undefined;
      },
      mount: (body) => mountPanel(api, library, body),
    });

    // -- Mod+T command -> the picker modal ------------------------------------
    api.commands.register({
      id: 'template.insert',
      label: 'Insert template',
      keybinding: 'Mod+T',
      run: () => openPicker(api, library),
    });

    // -- the `/` menu's Templates section (milestone 43) ------------------------
    api.editor.registerExtension('document', () => templateSlashExtension(api, library));

    // -- snippet completion (milestone 46): trigger words -> template blocks ----
    api.editor.registerExtension('document', () => snippetExtension(api, snippets));

    // -- drag source -> decoder ------------------------------------------------
    api.editor.registerDropDecoder({
      match: (data) => data.types.includes(TEMPLATE_DT_TYPE),
      decode: async (data) => {
        const relativePath = data.getData(TEMPLATE_DT_TYPE);
        const file = await api.vault.readFile(relativePath);
        const active = api.documents.active();
        const title = active ? (active.path.split('/').pop() ?? '').replace(/\.md$/i, '') : '';
        const now = new Date();
        return substitutePlaceholders(stripFrontmatter(file.content), {
          date: formatDate(now),
          time: formatTime(now),
          datetime: formatDateTime(now),
          title,
        });
      },
    });

    // -- recent templates in the editor context menu ---------------------------
    api.editor.registerContextMenuItems(() => {
      const items: ContextMenuItem[] = library.recent.map((t) => ({
        label: t.name,
        run: () => {
          void library.insert(t.relativePath).then((result) => showResult(api, result));
        },
      }));
      return items;
    });

    // -- settings page: the templates folder + the snippet library --------------
    api.ui.registerSettingsPage({
      id: 'templates',
      label: 'Templates',
      hint: 'Snippet library folder',
      mount: (body) => mountSettings(api, library, snippets, body),
    });
  },
};

type InsertResult = { ok: boolean; message?: string };

/** Surfaces an insert failure through the app's dialog (never `window.alert` — electron#41602). */
function showResult(api: DreyPluginApi, result: InsertResult): void {
  if (!result.ok && result.message !== undefined) {
    void api.ui.showMessage(result.message, 'Insert template failed');
  }
}

// -- panel -----------------------------------------------------------------

function mountPanel(api: DreyPluginApi, library: TemplateLibrary, body: HTMLElement): () => void {
  body.classList.add('tpl-panel');
  const list = el('div', 'tpl-list');
  body.appendChild(list);

  const render = (): void => {
    list.textContent = '';
    if (library.all.length === 0) {
      list.appendChild(
        el('div', 'tpl-empty', `No templates in ${library.dir}. Add .md files to the folder.`),
      );
      return;
    }
    for (const category of library.categories) {
      list.appendChild(categoryNode(api, library, category, 0));
    }
  };

  library.onChange(render);
  render();
  return () => undefined;
}

function categoryNode(
  api: DreyPluginApi,
  library: TemplateLibrary,
  category: TemplateCategory,
  depth: number,
): HTMLElement {
  const wrap = el('div', 'tpl-cat');
  const head = el('button', 'tpl-cat-head') as HTMLButtonElement;
  head.type = 'button';
  const chevron = el('span', 'tpl-chevron', '▾');
  head.appendChild(chevron);
  head.appendChild(el('span', 'tpl-cat-name', category.name));
  const children = el('div', 'tpl-cat-children');
  children.style.paddingLeft = `${(depth + 1) * 10}px`;
  wrap.appendChild(head);
  wrap.appendChild(children);

  const collapsed = { value: false };
  const apply = (): void => {
    children.style.display = collapsed.value ? 'none' : 'block';
    chevron.textContent = collapsed.value ? '▸' : '▾';
  };
  head.addEventListener('click', () => {
    collapsed.value = !collapsed.value;
    apply();
  });

  for (const entry of category.templates) {
    children.appendChild(templateRow(api, library, entry));
  }
  for (const child of category.children) {
    children.appendChild(categoryNode(api, library, child, depth + 1));
  }
  if (category.templates.length === 0 && category.children.length === 0) {
    children.appendChild(el('div', 'tpl-empty', 'Empty folder'));
  }
  apply();
  return wrap;
}

function templateRow(api: DreyPluginApi, library: TemplateLibrary, entry: TemplateEntry): HTMLElement {
  const row = el('div', 'tpl-row');
  row.textContent = entry.name;
  row.draggable = true;
  row.addEventListener('click', () => {
    void library.insert(entry.relativePath).then((r) => showRowResult(row, r));
  });
  row.addEventListener('dragstart', (event) => {
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer) {
      transfer.setData(TEMPLATE_DT_TYPE, entry.relativePath);
      transfer.setData('text/plain', entry.relativePath);
      transfer.effectAllowed = 'copy';
    }
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePreview();
    openRowMenu(event as MouseEvent, api, library, entry);
  });
  // Hover preview: the snippet as it would be inserted, in the same card
  // the slash menu shows. A short delay keeps a pointer just passing over
  // the list from flashing cards.
  row.addEventListener('mouseenter', () => schedulePreview(row, library, entry));
  row.addEventListener('mouseleave', closePreview);
  row.addEventListener('mousedown', closePreview);
  return row;
}

const PREVIEW_DELAY_MS = 350;
let previewTimer: number | null = null;
let previewToken = 0;

function closePreview(): void {
  previewToken += 1;
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
    previewTimer = null;
  }
  document.querySelectorAll('.slash-preview-pop').forEach((n) => n.remove());
}

function schedulePreview(row: HTMLElement, library: TemplateLibrary, entry: TemplateEntry): void {
  closePreview();
  const token = previewToken;
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    void library.render(entry.relativePath).then((text) => {
      if (token !== previewToken || text === null || !row.isConnected) {
        return;
      }
      const pop = el('div', 'slash-preview-pop');
      pop.appendChild(previewCard(entry.name, text));
      document.body.appendChild(pop);
      // Beside the row, on whichever side has room; clamped to the window.
      const rect = row.getBoundingClientRect();
      const width = pop.offsetWidth;
      const left =
        rect.right + 8 + width <= window.innerWidth ? rect.right + 8 : Math.max(8, rect.left - 8 - width);
      const top = Math.max(8, Math.min(rect.top, window.innerHeight - pop.offsetHeight - 8));
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    });
  }, PREVIEW_DELAY_MS);
}

/** The row's right-click menu: Insert / Edit template (ADR-0029). */
function openRowMenu(
  event: MouseEvent,
  api: DreyPluginApi,
  library: TemplateLibrary,
  entry: TemplateEntry,
): void {
  closeRowMenu();
  const menu = el('div', 'tpl-row-menu');
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 180)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 100)}px`;
  menu.appendChild(
    button('tpl-row-menu-item', 'Insert at the cursor', () => {
      closeRowMenu();
      void library.insert(entry.relativePath).then((result) => showResult(api, result));
    }),
  );
  menu.appendChild(
    button('tpl-row-menu-item', 'Open the template file', () => {
      closeRowMenu();
      void api.documents.open(entry.relativePath);
    }),
  );
  const backdrop = el('div', 'tpl-row-menu-backdrop');
  backdrop.addEventListener('mousedown', closeRowMenu);
  backdrop.appendChild(menu);
  document.body.appendChild(backdrop);
}

function closeRowMenu(): void {
  document.querySelectorAll('.tpl-row-menu-backdrop').forEach((n) => n.remove());
}

function showRowResult(row: HTMLElement, result: InsertResult): void {
  if (result.ok || result.message === undefined) {
    return;
  }
  row.title = result.message;
  row.classList.add('tpl-row-error');
  window.setTimeout(() => {
    row.classList.remove('tpl-row-error');
    row.removeAttribute('title');
  }, 2500);
}

// -- picker (Mod+T) ----------------------------------------------------------

function openPicker(api: DreyPluginApi, library: TemplateLibrary): void {
  let filter = '';
  let activeIndex = 0;
  let close: () => void = () => undefined;

  const box = el('div', 'tpl-picker');
  const input = el('input', 'tpl-picker-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'Filter templates…';
  const listBox = el('div', 'tpl-picker-list');

  const visible = (): TemplateEntry[] => library.filter(filter);

  const render = (): void => {
    listBox.textContent = '';
    const entries = visible();
    if (activeIndex >= entries.length) {
      activeIndex = Math.max(0, entries.length - 1);
    }
    const recentPaths = new Set(library.recent.map((t) => t.relativePath));
    entries.forEach((entry, index) => {
      const row = el(
        'div',
        'tpl-picker-row' + (index === activeIndex ? ' active' : ''),
        entry.name,
      );
      if (filter.trim() === '' && recentPaths.has(entry.relativePath)) {
        row.classList.add('recent');
      }
      row.addEventListener('click', () => choose(entry));
      row.addEventListener('mousemove', () => {
        if (activeIndex !== index) {
          activeIndex = index;
          render();
        }
      });
      listBox.appendChild(row);
    });
    if (entries.length === 0) {
      listBox.appendChild(el('div', 'tpl-empty', 'No matching template'));
    }
  };

  const choose = (entry: TemplateEntry): void => {
    void library.insert(entry.relativePath);
    close();
  };

  input.addEventListener('input', () => {
    filter = input.value;
    activeIndex = 0;
    render();
  });
  input.addEventListener('keydown', (event) => {
    const entries = visible();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const len = entries.length;
      if (len > 0) {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        activeIndex = (activeIndex + delta + len) % len;
        render();
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = entries[activeIndex];
      if (entry) {
        choose(entry);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  box.appendChild(input);
  box.appendChild(listBox);
  render();

  close = api.ui.showModal((mount) => {
    mount.classList.add('tpl-picker-host');
    mount.appendChild(box);
    window.setTimeout(() => input.focus(), 0);
  });
}

// -- settings page -----------------------------------------------------------

function mountSettings(
  api: DreyPluginApi,
  library: TemplateLibrary,
  snippets: SnippetStore,
  body: HTMLElement,
): () => void {
  // Built from the shared settings vocabulary (`plugin-settings-body`
  // classes — see plugins/AUTHORING.md): a field, its input, its hint.
  const field = el('div', 'field');
  const label = el('label', undefined, 'Templates folder (vault-relative)');
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.id = 'tpl-dir';
  label.setAttribute('for', 'tpl-dir');
  input.placeholder = 'templates';
  field.append(label, input);
  body.appendChild(field);

  const note = el('p', 'field-hint');
  body.appendChild(note);

  const show = (value: string, message?: string): void => {
    input.value = value;
    note.textContent =
      message ??
      'Folders are categories, .md files are templates. Saved immediately; invalid paths (e.g. "..") are rejected by the app config.';
    // The whole `templates` slice travels together: `appConfig.patch`
    // merges one level deep, so patching `{ dir }` alone would drop the
    // snippet library. `replaceDir` preserves it and the library re-reads
    // from the new folder.
    library.dir = value;
    void library.reload();
    void snippets.replaceDir(value);
  };

  void api.appConfig.get().then((config) => {
    input.value = config.templates.dir;
    library.dir = config.templates.dir;
    void library.reload();
    void renderSnippets(config.templates.snippets);
  });
  input.addEventListener('change', () => {
    const next = input.value.trim() === '' ? 'templates' : input.value;
    void api.appConfig
      .get()
      .then((config) =>
        api.appConfig.patch({ templates: { ...config.templates, dir: next } }),
      )
      .then(() => api.appConfig.get())
      .then((config) => show(config.templates.dir, 'Saved.'))
      .catch((error: unknown) => show(input.value, String(error)));
  });

  // -- snippet library (milestone 46) -----------------------------------------

  const section = el('section');
  section.appendChild(el('h3', undefined, 'Editor snippets'));
  section.appendChild(
    el(
      'p',
      'section-hint',
      'Typing a trigger word in a note offers the snippet\'s Markdown block; Tab walks its placeholders. Every snippet — the built-ins included — can be edited, removed or added to here. Changes are saved immediately.',
    ),
  );
  const rows = el('div', 'tpl-snippet-rows');
  section.appendChild(rows);

  const footer = el('div', 'tpl-snippet-actions');
  const status = el('span', 'tpl-snippet-status');
  const flashSaved = (): void => {
    status.textContent = 'Saved.';
    window.setTimeout(() => {
      if (status.textContent === 'Saved.') {
        status.textContent = '';
      }
    }, 1500);
  };

  const persist = (next: readonly SnippetConfig[]): void => {
    void snippets
      .replace(next)
      .then(flashSaved)
      .catch((error: unknown) => {
        status.textContent = String(error);
      });
  };

  const collect = (): SnippetConfig[] => {
    const out: SnippetConfig[] = [];
    for (const row of rows.querySelectorAll<HTMLDivElement>('.tpl-snippet-row')) {
      const trigger = (row.querySelector('.tpl-snippet-trigger') as HTMLInputElement).value
        .trim()
        .toLowerCase();
      const rowLabel = (row.querySelector('.tpl-snippet-label') as HTMLInputElement).value.trim();
      const template = (row.querySelector('.tpl-snippet-template') as HTMLTextAreaElement).value;
      if (trigger === '' || template.trim() === '') {
        continue;
      }
      out.push({
        trigger,
        label: rowLabel === '' ? trigger : rowLabel,
        template: template.replace(/\r\n/g, '\n'),
      });
    }
    return out;
  };

  let saveTimer: number | null = null;
  const scheduleSave = (): void => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      persist(collect());
    }, 500);
  };

  const snippetRow = (snippet: SnippetConfig): HTMLElement => {
    const row = el('div', 'tpl-snippet-row');

    const triggerLabel = el('label', undefined, 'Trigger');
    const trigger = el('input', 'tpl-snippet-trigger') as HTMLInputElement;
    trigger.value = snippet.trigger;
    trigger.addEventListener('input', scheduleSave);
    triggerLabel.append(trigger);

    const nameLabel = el('label', undefined, 'Name');
    const name = el('input', 'tpl-snippet-label') as HTMLInputElement;
    name.value = snippet.label;
    name.addEventListener('input', scheduleSave);
    nameLabel.append(name);

    const templateLabel = el('label', undefined, 'Template (${1:placeholder} = Tab stop, $0 = final caret)');
    const template = el('textarea', 'tpl-snippet-template') as HTMLTextAreaElement;
    template.rows = 3;
    template.value = snippet.template;
    template.addEventListener('input', scheduleSave);
    templateLabel.append(template);

    const remove = button('icon-btn tpl-snippet-remove', 'Remove this snippet', () => {
      row.remove();
      scheduleSave();
    });
    remove.setAttribute('aria-label', 'Remove this snippet');
    remove.appendChild(api.ui.icon('trash', 14));
    row.appendChild(remove);

    row.append(triggerLabel, nameLabel, templateLabel);
    return row;
  };

  const renderSnippets = (items: readonly SnippetConfig[]): void => {
    rows.textContent = '';
    for (const snippet of items) {
      rows.appendChild(snippetRow(snippet));
    }
    if (items.length === 0) {
      rows.appendChild(
        el('div', 'empty', 'No snippets. Add one below — typing its trigger word in a note will offer it.'),
      );
    }
  };

  const addRow = button('ghost tpl-add-snippet', 'Add snippet', () => {
    rows.querySelector('.tpl-empty')?.remove();
    const row = snippetRow({ trigger: '', label: '', template: '' });
    rows.appendChild(row);
    (row.querySelector('.tpl-snippet-trigger') as HTMLInputElement).focus();
  });
  addRow.appendChild(api.ui.icon('plus', 14));

  const restore = button('ghost tpl-restore-snippets', 'Restore the three built-ins (tbl, code, task)', () => {
    const current = collect();
    const merged = [...current];
    for (const fallback of SNIPPET_DEFAULTS) {
      if (!merged.some((snippet) => snippet.trigger === fallback.trigger)) {
        merged.push({ ...fallback });
      }
    }
    renderSnippets(merged);
    persist(merged);
  });
  restore.appendChild(api.ui.icon('rotate-ccw', 14));

  footer.append(status, addRow, restore);
  section.appendChild(footer);
  body.appendChild(section);
  return () => undefined;
}

export default plugin;
