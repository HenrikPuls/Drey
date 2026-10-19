import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { MutationResult } from '../shared/tickets';

/** The settings page's one DOM helper: an element with a class and text. */
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

/** An icon-only button (ADR-0057): the glyph, a title and an aria-label. */
export function iconButton(api: DreyPluginApi, icon: string, label: string): HTMLButtonElement {
  const button = el('button', 'icon-btn');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(api.ui.icon(icon, 14));
  return button;
}

/** A text button in the settings vocabulary (`ghost` or `primary`). */
export function textButton(label: string, kind: 'ghost' | 'primary' = 'ghost'): HTMLButtonElement {
  const button = el('button', `${kind} small`, label);
  button.type = 'button';
  return button;
}

/** A backend call that never throws: a failure is an `{ ok: false }` result. */
export async function mutate(api: DreyPluginApi, method: string, payload?: unknown): Promise<MutationResult> {
  try {
    return (await api.backend.invoke(method, payload)) as MutationResult;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
