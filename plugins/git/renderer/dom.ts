import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';

const WHEN = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** A text button in the dialogs (`git-btn`, plus `primary` / `danger`). */
export function textButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

/** Icon-only control: the words live in `title` + `aria-label`. A click does not reach the row behind it. */
export function iconButton(
  api: DreyPluginApi,
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = el('button', 'icon-btn');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(api.ui.icon(icon, 14));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An ISO time as local date + time; the raw text when it cannot be read. */
export function formatWhen(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? iso : WHEN.format(when);
}
