import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';

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

export function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', className, label) as HTMLButtonElement;
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** A text-glyph toggle (`Aa`, `ab`, `.*`) in the shared icon-button box. */
export function toggleButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = button('icon-btn glyph', label, onClick);
  node.title = title;
  node.setAttribute('aria-label', title);
  node.setAttribute('aria-pressed', 'false');
  return node;
}

/** Icon-only control: the words live in `title` + `aria-label`. */
export function iconButton(
  api: DreyPluginApi,
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const node = button('icon-btn', '', onClick);
  node.appendChild(api.ui.icon(icon, 14));
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}
