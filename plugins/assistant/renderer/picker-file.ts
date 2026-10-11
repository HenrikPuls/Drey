import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { baseName, dirName, el } from './dom.js';
import { pickerFrame, showPicker } from './picker-frame.js';
import type { AssistantState } from './state.js';
import type { VaultFileCache } from './vault-files.js';

/** One selectable row: a vault file/image, or an unsaved scratch tab. */
interface PickRow {
  id: string;
  scratch: boolean;
  label: string;
  detail: string;
  title: string;
}

/**
 * The "+" picker: the vault's Markdown files and unsaved scratch tabs on
 * one tab, its images on the other, plus a row to stage a file from the
 * computer. A pick lands as a context chip.
 */
export function openFilePicker(
  api: DreyPluginApi,
  state: AssistantState,
  vaultFiles: VaultFileCache,
  vaultImages: VaultFileCache,
): void {
  let close: () => void = () => undefined;
  let filter = '';
  let activeIndex = 0;
  let files: readonly string[] = [];
  let images: readonly string[] = [];
  let tab: 'files' | 'images' = 'files';
  const notePath = state.notePath();

  const { box, bodyArea } = pickerFrame('Attach');

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

  function renderList(): void {
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
  }

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

  close = showPicker(api, box, () => {
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
