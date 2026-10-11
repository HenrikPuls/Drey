import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { el, textButton } from './dom.js';

export interface Answer<T extends string> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
}

/** A question with labelled answers; resolves the chosen value, or null when dismissed. */
export function ask<T extends string>(
  api: DreyPluginApi,
  title: string,
  message: string,
  answers: ReadonlyArray<Answer<T>>,
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const settle = (value: T | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
        close();
      }
    };
    const close = api.ui.showModal((box) => {
      box.classList.add('git-dialog');
      box.append(el('h2', 'git-dialog-title', title), el('p', 'git-dialog-text', message));
      const row = el('div', 'git-dialog-actions');
      row.appendChild(textButton('git-btn', 'Cancel', () => settle(null)));
      for (const answer of answers) {
        const button = textButton('git-btn', answer.label, () => settle(answer.value));
        button.classList.toggle('primary', answer.primary === true);
        button.classList.toggle('danger', answer.danger === true);
        row.appendChild(button);
      }
      box.appendChild(row);
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          settle(null);
        }
      });
      queueMicrotask(() => {
        (row.lastElementChild as HTMLElement | null)?.focus();
        // A backdrop click closes the modal without an answer: watch for
        // the overlay leaving the page and count that as "Cancel".
        const backdrop = box.parentElement;
        if (backdrop === null) {
          return;
        }
        const observer = new MutationObserver(() => {
          if (!backdrop.isConnected) {
            observer.disconnect();
            settle(null);
          }
        });
        observer.observe(document.body, { childList: true });
      });
    });
  });
}
