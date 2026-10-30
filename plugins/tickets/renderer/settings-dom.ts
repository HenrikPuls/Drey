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

// --- plugin-config fields (the Fleet and Workers sections) -----------------

/** One label/value row of a `tset-kv` grid: the control above its hint. */
export function kv(id: string, label: string, control: HTMLInputElement | HTMLSelectElement, hint: string): HTMLElement[] {
  control.id = id;
  const name = el('label', 'tset-kv-label', label);
  name.htmlFor = id;
  const value = el('div', 'tset-kv-value');
  value.append(control, el('span', 'field-hint', hint));
  return [name, value];
}

export function selectConfig(
  api: DreyPluginApi,
  key: string,
  choices: ReadonlyArray<readonly [string, string]>,
  fallback: string,
): HTMLSelectElement {
  const select = el('select');
  for (const [value, label] of choices) {
    select.append(Object.assign(el('option', undefined, label), { value }));
  }
  void api.settings.get<string>(key).then((value) => {
    select.value = value ?? fallback;
  });
  select.addEventListener('change', () => {
    void api.settings.set(key, select.value).catch(() => undefined);
  });
  return select;
}

export function textConfig(api: DreyPluginApi, key: string): HTMLInputElement {
  const input = el('input', 'mono-input');
  input.type = 'text';
  input.spellcheck = false;
  void api.settings.get<string>(key).then((value) => {
    input.value = value ?? '';
  });
  input.addEventListener('change', () => {
    void api.settings.set(key, input.value.trim()).catch(() => undefined);
  });
  return input;
}

/** A whole-number config field; empty or invalid clears back to the default. */
export function numberConfig(api: DreyPluginApi, key: string): HTMLInputElement {
  const input = el('input', 'mono-input');
  input.type = 'number';
  input.min = '0';
  input.step = '1';
  void api.settings.get<number>(key).then((value) => {
    input.value = typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  });
  input.addEventListener('change', () => {
    const parsed = Number(input.value);
    void api.settings
      .set(key, input.value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : '')
      .catch(() => undefined);
  });
  return input;
}

/** A backend call that never throws: a failure is an `{ ok: false }` result. */
export async function mutate(api: DreyPluginApi, method: string, payload?: unknown): Promise<MutationResult> {
  try {
    return (await api.backend.invoke(method, payload)) as MutationResult;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
