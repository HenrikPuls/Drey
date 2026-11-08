// i18n: catalog
/**
 * The Find panel's `⋯` menu (board 9c): one popover under the header, rows
 * of 28 px with a check slot, a section label and separators. Plain DOM in
 * the document body (the panel's own box clips), closed by Escape, an outside
 * press or a pick.
 */
import type { DreyPluginApi, FindMenuEntry } from '../../../shared/plugin-api/renderer';
import { el } from './dom.js';

/** A menu row: the SDK's rows plus a plain action (Export, Summarize). */
export type FindMenuRow =
  | FindMenuEntry
  | {
      readonly kind: 'item';
      readonly label: string;
      readonly title?: string;
      readonly disabled?: boolean;
      run(): void;
    };

const WIDTH = 236;

/** Opens the menu under `anchor`'s panel header; returns the close function. */
export function openFindMenu(
  api: DreyPluginApi,
  anchor: HTMLElement,
  rows: readonly FindMenuRow[],
  onClose: () => void,
): () => void {
  const menu = el('div', 'find-menu');
  menu.setAttribute('role', 'menu');
  const items: HTMLButtonElement[] = [];

  for (const row of rows) {
    if (row.kind === 'separator') {
      menu.appendChild(el('div', 'find-menu-sep'));
      continue;
    }
    if (row.kind === 'label') {
      menu.appendChild(el('div', 'find-menu-label', row.label));
      continue;
    }
    const item = el('button', 'find-menu-item') as HTMLButtonElement;
    item.type = 'button';
    const slot = el('span', 'find-menu-check');
    if (row.kind === 'check' && row.checked) {
      slot.appendChild(api.ui.icon('check', 14));
    }
    item.append(slot, el('span', 'find-menu-text', row.label));
    if (row.kind === 'check') {
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', String(row.checked));
    } else {
      item.setAttribute('role', 'menuitem');
      item.disabled = row.disabled === true;
      if (row.title !== undefined) {
        item.title = row.title;
      }
    }
    item.addEventListener('click', () => {
      close();
      row.run();
    });
    items.push(item);
    menu.appendChild(item);
  }

  const frame = anchor.closest('app-panel-frame') ?? anchor;
  const box = frame.getBoundingClientRect();
  const head = anchor.getBoundingClientRect();
  menu.style.width = `${WIDTH}px`;
  menu.style.left = `${Math.max(4, box.right - 6 - WIDTH)}px`;
  menu.style.top = `${Math.max(box.top + 28, head.bottom + 2)}px`;
  document.body.appendChild(menu);
  anchor.setAttribute('aria-expanded', 'true');

  let closed = false;
  const onDown = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) {
      close();
    }
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      anchor.focus();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const enabled = items.filter((item) => !item.disabled);
      const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
      enabled[(next + enabled.length) % enabled.length]?.focus();
    }
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  items.find((item) => !item.disabled)?.focus();

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    onClose();
  }
  return close;
}
