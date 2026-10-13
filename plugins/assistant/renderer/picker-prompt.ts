import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { el } from './dom.js';
import { pickerFrame, showPicker } from './picker-frame.js';
import {
  PROMPTS_DIR,
  promptEntriesFrom,
  promptsDirFor,
  type PromptEntry,
} from './prompts.js';
import type { VaultFileCache } from './vault-files.js';

/**
 * The prompt picker (req: pick a prompt from the templates folder — the
 * successor of the removed "Summarise now"): lists `templates/prompts/`
 * Markdown files (title + description), and picking one hands its body to
 * `insert`, which REPLACES the composer's text — the user reviews and
 * sends it as a normal question.
 */
export async function openPromptPicker(
  api: DreyPluginApi,
  vaultFiles: VaultFileCache,
  insert: (body: string) => void,
): Promise<void> {
  let close: () => void = () => undefined;

  const { box, bodyArea } = pickerFrame('Prompts');

  const listBox = el('div', 'assistant-picker-list');
  bodyArea.appendChild(listBox);

  let prompts: readonly PromptEntry[] = [];
  let dir = PROMPTS_DIR;
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
        insert(prompt.body);
      });
      listBox.appendChild(rowEl);
    }
    if (prompts.length === 0) {
      listBox.appendChild(
        el(
          'div',
          'assistant-picker-empty',
          `No prompts in ${dir}/ — add .md files there.`,
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

  close = showPicker(api, box);

  // Re-read on every open (the cache invalidates itself on vault changes).
  try {
    dir = promptsDirFor((await api.appConfig.get()).templates.dir);
    prompts = await promptEntriesFrom(
      await vaultFiles.ensureLoaded(),
      (path) => api.vault.readFile(path).then((file) => file.content),
      dir,
    );
    renderList();
  } catch {
    // The empty state stays; the read failure is not worth an error line.
  }
}
