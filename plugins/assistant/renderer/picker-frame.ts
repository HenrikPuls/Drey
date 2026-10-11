import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { el } from './dom.js';

/** The box every assistant picker is built in: a head line above a body. */
export interface PickerFrame {
  readonly box: HTMLElement;
  readonly headLabel: HTMLElement;
  readonly bodyArea: HTMLElement;
}

export function pickerFrame(title: string): PickerFrame {
  const box = el('div', 'assistant-picker');
  const headLabel = el('div', 'assistant-picker-head', title);
  const bodyArea = el('div', 'assistant-picker-body');
  box.append(headLabel, bodyArea);
  return { box, headLabel, bodyArea };
}

/**
 * Shows the picker as a modal (`api.ui.showModal`; same gesture as the
 * templates picker). Returns the function that closes it.
 */
export function showPicker(api: DreyPluginApi, box: HTMLElement, onMounted?: () => void): () => void {
  return api.ui.showModal((mount) => {
    mount.classList.add('assistant-picker-host');
    mount.appendChild(box);
    onMounted?.();
  });
}
