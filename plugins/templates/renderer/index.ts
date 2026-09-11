import type {
  ContextMenuItem,
  DreyPluginApi,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import { TemplateLibrary, type TemplateCategory, type TemplateEntry } from './library.js';
import { formatDate, formatDateTime, formatTime, stripFrontmatter, substitutePlaceholders } from './pure.js';

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

    // -- panel ---------------------------------------------------------------
    api.ui.registerWidget({
      id: 'templates',
      title: 'Templates',
      defaultDock: 'left',
      defaultOpen: false,
      defaultFlex: 200,
      headerActions: (actions) => {
        actions.appendChild(
          button('tpl-hdr-btn', 'Re-read the vault from disk', () => void library.reload()),
        );
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
          void library.insert(t.relativePath).then(showResult);
        },
      }));
      return items;
    });

    // -- settings page: the templates folder -----------------------------------
    api.ui.registerSettingsPage({
      id: 'templates',
      label: 'Templates',
      hint: 'Snippet library folder',
      mount: (body) => mountSettings(api, library, body),
    });
  },
};

type InsertResult = { ok: boolean; message?: string };

/** Surfaces an insert failure: the alert is rare and matches how base errors surfaced. */
function showResult(result: InsertResult): void {
  if (!result.ok && result.message !== undefined) {
    window.alert(result.message);
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
    openRowMenu(event as MouseEvent, api, library, entry);
  });
  return row;
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
      void library.insert(entry.relativePath).then(showResult);
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

function mountSettings(api: DreyPluginApi, library: TemplateLibrary, body: HTMLElement): () => void {
  body.classList.add('tpl-settings');
  const label = el('label', 'tpl-settings-label', 'Templates folder (vault-relative)');
  const input = el('input', 'tpl-settings-input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'templates';
  label.appendChild(input);
  body.appendChild(label);

  const note = el('div', 'tpl-settings-note');
  body.appendChild(note);

  const show = (value: string, message?: string): void => {
    input.value = value;
    note.textContent =
      message ??
      'Folders are categories, .md files are templates. Saved immediately; invalid paths (e.g. "..") are rejected by the app config.';
    library.dir = value;
    void library.reload();
  };

  void api.appConfig.get().then((config) => {
    input.value = config.templates.dir;
    library.dir = config.templates.dir;
    void library.reload();
  });
  input.addEventListener('change', () => {
    const next = input.value.trim() === '' ? 'templates' : input.value;
    void api.appConfig
      .patch({ templates: { dir: next } })
      .then(() => api.appConfig.get())
      .then((config) => show(config.templates.dir, 'Saved.'))
      .catch((error: unknown) => show(input.value, String(error)));
  });
  return () => undefined;
}

export default plugin;
