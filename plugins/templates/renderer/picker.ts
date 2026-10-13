import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import {
  flatten,
  type TemplateCategory,
  type TemplateEntry,
  type TemplateLibrary,
} from './library.js';
import { clip } from './slash.js';

/**
 * The template picker (req-41): one field to filter, the library as a
 * folder tree beside a preview of the row the keys are on. Mounted into
 * the formatting bar's popover (`registerToolbarButtons`, `popover`) and
 * floated at the caret by the `/` menu's "Templates…" row -- the same
 * DOM either way.
 *
 * Built for a large library: folders start collapsed once the library
 * outgrows a screenful, the list scrolls, and typing switches to a flat
 * list of matches. Everything is reachable from the keyboard -- the
 * field keeps the focus, the arrow keys move the active row.
 */

/** Above this many templates the folders start collapsed. */
export const COLLAPSE_ABOVE = 24;

const PREVIEW_LINES = 16;

export type PickerRow =
  | { kind: 'label'; text: string }
  | { kind: 'folder'; path: string; name: string; depth: number; open: boolean; count: number }
  | { kind: 'template'; entry: TemplateEntry; depth: number; detail: string };

/** How many templates a folder holds, its subfolders included. */
export function countTemplates(category: TemplateCategory): number {
  return category.templates.length + category.children.reduce((n, c) => n + countTemplates(c), 0);
}

/** `templates/meetings/weekly/1-1.md` under `templates` -> `meetings/weekly`; a root file -> ``. */
export function folderOf(entry: TemplateEntry, libraryDir: string): string {
  const inner = entry.relativePath.startsWith(`${libraryDir}/`)
    ? entry.relativePath.slice(libraryDir.length + 1)
    : entry.relativePath;
  const slash = inner.lastIndexOf('/');
  return slash === -1 ? '' : inner.slice(0, slash);
}

/** Every folder path of the tree -- the initial collapse set of a large library. */
export function folderPaths(categories: readonly TemplateCategory[], libraryDir: string): string[] {
  const out: string[] = [];
  const walk = (cats: readonly TemplateCategory[]): void => {
    for (const cat of cats) {
      if (cat.path !== libraryDir) {
        out.push(cat.path);
      }
      walk(cat.children);
    }
  };
  walk(categories);
  return out;
}

/**
 * The rows the list shows. No filter: the recents, then the tree -- root
 * files first, folders with their rows while open. With a filter: a flat
 * list of the templates whose name or path contains it, each carrying
 * its folder so equal names stay apart.
 */
export function pickerRows(
  categories: readonly TemplateCategory[],
  recent: readonly TemplateEntry[],
  filter: string,
  collapsed: ReadonlySet<string>,
  libraryDir: string,
): PickerRow[] {
  const template = (entry: TemplateEntry, depth: number, detail: string): PickerRow => ({
    kind: 'template',
    entry,
    depth,
    detail,
  });
  const q = filter.trim().toLowerCase();
  if (q !== '') {
    return flatten(categories)
      .filter((t) => t.name.toLowerCase().includes(q) || t.relativePath.toLowerCase().includes(q))
      .map((entry) => template(entry, 0, folderOf(entry, libraryDir)));
  }

  const rows: PickerRow[] = [];
  if (recent.length > 0) {
    rows.push({ kind: 'label', text: 'Recent' });
    rows.push(...recent.map((entry) => template(entry, 0, folderOf(entry, libraryDir))));
    rows.push({ kind: 'label', text: 'All templates' });
  }
  const walk = (cats: readonly TemplateCategory[], depth: number): void => {
    for (const cat of cats) {
      if (cat.path === libraryDir) {
        // The library root's own files: no folder row of their own.
        rows.push(...cat.templates.map((entry) => template(entry, depth, '')));
        continue;
      }
      const open = !collapsed.has(cat.path);
      rows.push({
        kind: 'folder',
        path: cat.path,
        name: cat.name,
        depth,
        open,
        count: countTemplates(cat),
      });
      if (open) {
        rows.push(...cat.templates.map((entry) => template(entry, depth + 1, '')));
        walk(cat.children, depth + 1);
      }
    }
  };
  walk(categories, 0);
  return rows;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

/**
 * Mounts the picker into `mount`. `onPick` receives the chosen template
 * (the caller inserts it); `close` dismisses the surrounding popover.
 * Returns the teardown.
 */
export function mountTemplatePicker(
  api: DreyPluginApi,
  library: TemplateLibrary,
  mount: HTMLElement,
  onPick: (entry: TemplateEntry) => void,
  close: () => void,
): () => void {
  mount.classList.add('tpl-pick');

  const side = el('div', 'tpl-pick-side');
  const filterBox = el('div', 'tpl-pick-filter');
  filterBox.appendChild(api.ui.icon('search', 14));
  const input = el('input', 'tpl-pick-input');
  input.type = 'text';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Filter templates');
  filterBox.appendChild(input);
  const list = el('div', 'tpl-pick-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Templates');
  side.append(filterBox, list);

  const preview = el('div', 'tpl-pick-preview');
  const head = el('div', 'tpl-pick-head');
  const body = el('pre', 'tpl-pick-body');
  const foot = el('div', 'tpl-pick-foot', 'Enter inserts at the caret');
  preview.append(head, body, foot);
  mount.append(side, preview);

  const categories = (): TemplateCategory[] => library.noteCategories;
  const collapsed = new Set<string>(
    flatten(categories()).length > COLLAPSE_ABOVE ? folderPaths(categories(), library.dir) : [],
  );
  let rows: PickerRow[] = [];
  /** Index into `rows` of the row the keys are on; -1 while nothing is selectable. */
  let active = -1;
  let previewToken = 0;

  const selectable = (row: PickerRow | undefined): boolean =>
    row !== undefined && row.kind !== 'label';

  const showPreview = (): void => {
    previewToken += 1;
    const token = previewToken;
    const row = rows[active];
    if (row === undefined || row.kind === 'label') {
      head.textContent = '';
      body.textContent = '';
      return;
    }
    if (row.kind === 'folder') {
      head.textContent = row.path;
      body.textContent = row.count === 1 ? '1 template' : `${row.count} templates`;
      return;
    }
    head.textContent = row.entry.relativePath;
    body.textContent = '';
    void library.render(row.entry.relativePath).then((text) => {
      if (token === previewToken) {
        body.textContent =
          text === null ? 'This template could not be read.' : clip(text, PREVIEW_LINES);
      }
    });
  };

  const markActive = (): void => {
    for (const node of list.querySelectorAll<HTMLElement>('[data-row]')) {
      const on = Number(node.dataset['row']) === active;
      node.classList.toggle('active', on);
      node.setAttribute('aria-selected', String(on));
      if (on) {
        node.scrollIntoView?.({ block: 'nearest' });
      }
    }
    showPreview();
  };

  const setActive = (index: number): void => {
    if (index !== active && selectable(rows[index])) {
      active = index;
      markActive();
    }
  };

  const activate = (index: number): void => {
    const row = rows[index];
    if (row === undefined || row.kind === 'label') {
      return;
    }
    if (row.kind === 'folder') {
      if (row.open) {
        collapsed.add(row.path);
      } else {
        collapsed.delete(row.path);
      }
      render(row.path);
      return;
    }
    onPick(row.entry);
    close();
  };

  /** Rebuilds the list; `keepFolder` keeps the keys on a just-toggled folder. */
  const render = (keepFolder?: string): void => {
    const recent = library.recent.filter((t) =>
      flatten(categories()).some((n) => n.relativePath === t.relativePath),
    );
    rows = pickerRows(categories(), recent, input.value, collapsed, library.dir);
    active = rows.findIndex((row) =>
      keepFolder === undefined ? selectable(row) : row.kind === 'folder' && row.path === keepFolder,
    );
    list.textContent = '';
    if (rows.length === 0) {
      list.appendChild(
        el(
          'div',
          'tpl-pick-empty',
          input.value.trim() === ''
            ? `No templates in ${library.dir}. Add .md files to the folder.`
            : 'No matching template',
        ),
      );
    }
    rows.forEach((row, index) => {
      if (row.kind === 'label') {
        list.appendChild(el('div', 'tpl-pick-label', row.text));
        return;
      }
      const node = el('div', `tpl-pick-row ${row.kind}`);
      node.dataset['row'] = String(index);
      node.setAttribute('role', 'option');
      node.style.paddingLeft = `${10 + row.depth * 14}px`;
      if (row.kind === 'folder') {
        node.appendChild(api.ui.icon(row.open ? 'chevron-down' : 'chevron-right', 12));
        node.appendChild(el('span', 'tpl-pick-name', row.name));
        node.appendChild(el('span', 'tpl-pick-detail', String(row.count)));
        node.setAttribute('aria-expanded', String(row.open));
      } else {
        node.appendChild(el('span', 'tpl-pick-name', row.entry.name));
        if (row.detail !== '') {
          node.appendChild(el('span', 'tpl-pick-detail', row.detail));
        }
      }
      node.addEventListener('mousemove', () => setActive(index));
      // mousedown, not click: the field keeps the focus, so the arrow
      // keys go on working after a folder was opened with the mouse.
      node.addEventListener('mousedown', (event) => {
        event.preventDefault();
        activate(index);
      });
      list.appendChild(node);
    });
    markActive();
  };

  const move = (delta: 1 | -1): void => {
    for (let i = active + delta; i >= 0 && i < rows.length; i += delta) {
      if (selectable(rows[i])) {
        setActive(i);
        return;
      }
    }
  };

  const edge = (from: 'first' | 'last'): void => {
    const indexes = rows.map((row, i) => (selectable(row) ? i : -1)).filter((i) => i !== -1);
    const target = from === 'first' ? indexes[0] : indexes[indexes.length - 1];
    if (target !== undefined) {
      setActive(target);
    }
  };

  const onKeydown = (event: KeyboardEvent): void => {
    const row = rows[active];
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'PageDown':
        edge('last');
        break;
      case 'PageUp':
        edge('first');
        break;
      case 'ArrowRight':
        // Only at the end of the typed filter, so the caret keeps its keys.
        if (row?.kind === 'folder' && !row.open && input.selectionStart === input.value.length) {
          activate(active);
        } else {
          handled = false;
        }
        break;
      case 'ArrowLeft':
        if (row?.kind === 'folder' && row.open && input.selectionStart === 0) {
          activate(active);
        } else {
          handled = false;
        }
        break;
      case 'Enter':
        activate(active);
        break;
      case 'Escape':
        close();
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  mount.addEventListener('keydown', onKeydown);
  input.addEventListener('input', () => render());
  const offChange = library.onChange(() => render());
  render();
  const focusTimer = window.setTimeout(() => input.focus(), 0);

  return () => {
    window.clearTimeout(focusTimer);
    previewToken += 1;
    offChange();
    mount.removeEventListener('keydown', onKeydown);
  };
}

/**
 * Floats the picker at a caret position (the `/` menu's "Templates…"
 * row): below the caret, above it when the window ends first. `onClose`
 * runs on every way out, so the caller can hand the focus back.
 */
export function openTemplatePickerAt(
  api: DreyPluginApi,
  library: TemplateLibrary,
  anchor: { left: number; top: number; bottom: number },
  onPick: (entry: TemplateEntry) => void,
  onClose: () => void,
): void {
  const backdrop = el('div', 'tpl-pick-backdrop');
  const box = el('div', 'tpl-pick-float');
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);

  let dispose: () => void = () => undefined;
  let open = true;
  const close = (): void => {
    if (!open) {
      return;
    }
    open = false;
    dispose();
    backdrop.remove();
    onClose();
  };
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) {
      close();
    }
  });
  dispose = mountTemplatePicker(api, library, box, onPick, close);

  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const below = anchor.bottom + 4;
  box.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
  box.style.top = `${
    below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - height - 4)
  }px`;
}
