import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { deriveVaultScope } from '../shared/vault-context.js';
import { el, icon } from './dom.js';
import { pickerFrame, showPicker } from './picker-frame.js';
import type { AssistantState } from './state.js';

/**
 * The Vault chip's picker (ADR-0055 later change): three shortcut rows
 * — Off, the active vault, every vault — then one checkbox row per
 * registered vault. Toggling rows derives the scope live (none → off,
 * the active one → vault, all → all, any other subset → custom), so a
 * selection can target e.g. a non-active Git vault without making it
 * the default target for new content. A check from a shortcut scope
 * REPLACES the selection (ADR-0069 — no silent carry-over of the
 * shortcut's vaults). Shortcuts apply and close; row toggles keep the
 * picker open for multi-select.
 */
export function openVaultPicker(api: DreyPluginApi, state: AssistantState): void {
  let close: () => void = () => undefined;
  let unsubscribe: (() => void) | null = null;

  const closePicker = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    close();
  };

  const { box, bodyArea } = pickerFrame('Vault context');

  const listBox = el('div', 'assistant-picker-list');
  bodyArea.appendChild(listBox);
  const doneBtn = el('button', 'assistant-picker-foot', 'Done') as HTMLButtonElement;
  doneBtn.type = 'button';
  doneBtn.addEventListener('click', closePicker);
  bodyArea.appendChild(doneBtn);

  /** The ids a shortcut row stands for. */
  const shortcutIds = (scope: 'off' | 'vault' | 'all'): string[] => {
    const vaults = state.vaults();
    if (scope === 'all') {
      return vaults.map((vault) => vault.id);
    }
    if (scope === 'vault') {
      return vaults.filter((vault) => vault.active).map((vault) => vault.id);
    }
    return [];
  };

  const renderList = (): void => {
    listBox.textContent = '';
    const vaults = state.vaults();
    const scope = state.vaultScope();
    const checked =
      scope === 'all'
        ? shortcutIds('all')
        : scope === 'vault'
          ? shortcutIds('vault')
          : scope === 'custom'
            ? state.customVaultIds()
            : [];

    const shortcutRow = (label: string, detail: string, target: 'off' | 'vault' | 'all'): void => {
      const rowEl = el('div', 'assistant-picker-row' + (scope === target ? ' current' : ''));
      rowEl.appendChild(el('span', 'row-title', label));
      if (detail !== '') {
        rowEl.appendChild(el('span', 'assistant-picker-detail', detail));
      }
      rowEl.addEventListener('click', () => {
        state.setVaultScope(target, shortcutIds(target));
        closePicker();
      });
      listBox.appendChild(rowEl);
    };

    const active = vaults.find((vault) => vault.active) ?? null;
    shortcutRow('Off', '', 'off');
    shortcutRow('Active vault', active !== null ? active.name : 'none registered', 'vault');
    shortcutRow('All vaults', `${vaults.length} registered`, 'all');
    listBox.appendChild(el('div', 'assistant-picker-sep'));

    for (const vault of vaults) {
      const isChecked = checked.includes(vault.id);
      const rowEl = el('div', 'assistant-picker-row vault-choice');
      const check = el('span', 'row-check');
      if (isChecked) {
        check.appendChild(icon('check', 10));
      }
      rowEl.appendChild(check);
      rowEl.appendChild(el('span', 'row-title', vault.name));
      rowEl.appendChild(el('span', 'assistant-picker-detail', vault.active ? 'active' : ''));
      rowEl.title = vault.name;
      rowEl.setAttribute('role', 'checkbox');
      rowEl.setAttribute('aria-checked', String(isChecked));
      rowEl.addEventListener('click', () => {
        // Replace semantics (ADR-0069): the first CHECK from a shortcut
        // scope starts a fresh selection with just that vault — the old
        // behaviour added to the shortcut's set, so an "Active vault" +
        // one checkbox click silently queried both vaults. Unchecking
        // still operates on the visible list (an "All vaults" uncheck
        // degrades to the remaining subset, as before).
        const next = isChecked
          ? checked.filter((id) => id !== vault.id)
          : scope === 'vault' || scope === 'all'
            ? [vault.id]
            : [...checked, vault.id];
        const derived = deriveVaultScope(next, vaults);
        state.setVaultScope(derived.scope, derived.vaultIds);
        // renderList rides the state subscription; nothing else to do.
      });
      listBox.appendChild(rowEl);
    }
    if (vaults.length === 0) {
      listBox.appendChild(
        el('div', 'assistant-picker-empty', 'No vaults registered — add one in the Files panel.'),
      );
    }
  };
  renderList();

  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePicker();
    }
  });

  close = showPicker(api, box);
  unsubscribe = state.subscribe(renderList);
  void state.refreshVaults(); // names + a possibly-pruned selection
}
