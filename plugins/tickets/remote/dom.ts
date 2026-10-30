/**
 * The phone client's DOM helpers (req-66). Plain DOM, text through
 * `textContent` only — nothing from a ticket ever reaches innerHTML.
 */
type Child = Node | string | null | undefined | false;

export interface Props {
  readonly class?: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly on?: Readonly<Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class !== undefined) {
    node.className = props.class;
  }
  if (props.text !== undefined) {
    node.textContent = props.text;
  }
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [name, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(name, handler as EventListener);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      node.append(child);
    }
  }
  return node;
}

export function button(label: string, onClick: () => void, className = 'btn'): HTMLButtonElement {
  return h('button', { class: className, text: label, attrs: { type: 'button' }, on: { click: () => onClick() } });
}

const ICONS: Readonly<Record<string, string>> = {
  inbox: 'M4 13h4l2 3h4l2-3h4M4 13V6h16v7M4 13v5h16v-5',
  board: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 5l-7 7 7 7',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

export function icon(name: string, size = 22): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** One message above the tab bar; an error stays until tapped. */
export function toast(text: string, kind: 'ok' | 'error' = 'ok'): void {
  document.querySelector('.toast')?.remove();
  if (toastTimer !== null) {
    clearTimeout(toastTimer);
  }
  const node = h('div', { class: `toast toast-${kind}`, text, attrs: { role: kind === 'error' ? 'alert' : 'status' } });
  node.addEventListener('click', () => node.remove());
  document.body.append(node);
  if (kind === 'ok') {
    toastTimer = setTimeout(() => node.remove(), 3000);
  }
}

/** A bottom sheet over a scrim; returns the close function. */
export function sheet(title: string, content: Node[], onClose?: () => void): () => void {
  const close = (): void => {
    root.remove();
    onClose?.();
  };
  const root = h(
    'div',
    { class: 'sheet-root' },
    h('div', { class: 'scrim', on: { click: close } }),
    h(
      'div',
      { class: 'sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': title } },
      h('div', { class: 'grab' }),
      h('div', { class: 'sheet-head' }, h('h2', { text: title }), button('Cancel', close, 'link')),
      ...content,
    ),
  );
  document.body.append(root);
  return close;
}

/** A button that needs a second tap within three seconds (the board's armed two-step). */
export function armedButton(label: string, armedLabel: string, onConfirm: () => void, className = 'btn btn-danger'): HTMLButtonElement {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const node = button(label, () => {
    if (armed) {
      if (timer !== null) {
        clearTimeout(timer);
      }
      onConfirm();
      return;
    }
    armed = true;
    node.textContent = armedLabel;
    node.classList.add('armed');
    timer = setTimeout(() => {
      armed = false;
      node.textContent = label;
      node.classList.remove('armed');
    }, 3000);
  }, className);
  return node;
}

/** The items that are there — for child lists with optional parts. */
export function present<T>(items: readonly (T | null | undefined | false)[]): T[] {
  return items.filter((item): item is T => item !== null && item !== undefined && item !== false);
}
