/**
 * The panel's dropdown menu (board 9d): a list of rows under the button
 * that opened it, right-aligned to it — the "More Git actions" menu and
 * the repository switch. Plain DOM, position fixed, appended inside the
 * panel's frame: a press in the menu stays a press in the panel, so the
 * panel stays the active one and its header controls stay (req-163,
 * milestone 208). It closes on a row, Escape, or a press outside.
 */
import { el } from './dom.js';

export type DropdownEntry =
  | {
      readonly label: string;
      /** Right-aligned extra: a shortcut or a count. */
      readonly hint?: string;
      readonly disabled?: boolean;
      /** A selected row (the shown repository) draws a check in the slot. */
      readonly checked?: boolean;
      readonly run: () => void;
    }
  | 'separator';

/** Opens the menu under `anchor`; returns the close function. */
export function openDropdown(
  anchor: HTMLElement,
  label: string,
  entries: readonly DropdownEntry[],
  checkIcon: () => Element,
  width?: number,
): () => void {
  const menu = el('div', 'git-menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  if (width !== undefined) {
    menu.style.width = `${width}px`;
  }
  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    menu.remove();
    window.removeEventListener('mousedown', outside, true);
    anchor.setAttribute('aria-expanded', 'false');
    anchor.focus();
  };
  const outside = (event: Event): void => {
    const target = event.target as Node;
    if (!menu.contains(target) && !anchor.contains(target)) {
      close();
    }
  };
  for (const entry of entries) {
    if (entry === 'separator') {
      menu.appendChild(el('div', 'git-menu-sep'));
      continue;
    }
    const row = el('button', 'git-menu-item');
    row.type = 'button';
    row.setAttribute('role', 'menuitem');
    row.disabled = entry.disabled === true;
    const slot = el('span', 'ck');
    if (entry.checked === true) {
      slot.appendChild(checkIcon());
    }
    row.append(slot, el('span', 'label', entry.label));
    if (entry.hint !== undefined) {
      row.appendChild(el('span', 'hint', entry.hint));
    }
    row.addEventListener('click', () => {
      close();
      entry.run();
    });
    menu.appendChild(row);
  }
  menu.addEventListener('keydown', (event) => {
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('.git-menu-item:not(:disabled)')];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      rows[(at + step + rows.length) % rows.length]?.focus();
    }
  });
  (anchor.closest('app-panel-frame') ?? document.body).appendChild(menu);
  // Board 9d: the menu's right edge 6 px in from the panel's, its top on
  // the header's bottom edge — i.e. under the button, right-aligned.
  const box = anchor.getBoundingClientRect();
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(box.right - rect.width, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.min(box.bottom + 2, window.innerHeight - rect.height - 8)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  window.addEventListener('mousedown', outside, true);
  menu.querySelector<HTMLButtonElement>('.git-menu-item:not(:disabled)')?.focus();
  return close;
}
