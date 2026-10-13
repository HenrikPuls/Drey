/**
 * The selection popover (milestone 74): opened from the assistant button at
 * a selection. One question field, the prompts from the vault's prompts
 * folder, then the manual Actions. A question or a prompt is asked about
 * the selection in the chat; an Action rewrites the document with the
 * selection as its focus.
 *
 * Plain DOM, fixed-positioned on `document.body` (ADR-0044 rule 2). One
 * popover at a time; outside press and Escape close it.
 */
import { el } from './dom.js';
import type { PromptEntry } from './prompts.js';

export interface PopoverAnchor {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

export interface PopoverAction {
  readonly triggerId: string;
  readonly name: string;
}

export interface SelectionPopoverOptions {
  readonly anchor: PopoverAnchor;
  /** Resolves with the prompt list; the rows appear when it lands. */
  readonly prompts: Promise<readonly PromptEntry[]>;
  readonly actions: readonly PopoverAction[];
  /** A typed question or a picked prompt's body. */
  onAsk(question: string): void;
  onAction(triggerId: string): void;
  /** Called once when the popover closes without a choice (Escape, outside press). */
  onDismiss?(): void;
}

const WIDTH = 320;

let open: { close: () => void } | null = null;

/** Closes the open selection popover, if any. */
export function closeSelectionPopover(): void {
  open?.close();
}

export function openSelectionPopover(options: SelectionPopoverOptions): () => void {
  closeSelectionPopover();

  const root = el('div', 'assistant-selection-popover');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Ask the assistant about the selection');

  const input = el('input', 'selection-question');
  input.type = 'text';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Question about the selection');
  root.appendChild(input);

  const list = el('div', 'selection-rows');
  root.appendChild(list);

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    document.removeEventListener('mousedown', onDown, true);
    root.remove();
    if (open?.close === close) {
      open = null;
    }
  };
  const dismiss = (): void => {
    close();
    options.onDismiss?.();
  };
  const onDown = (event: MouseEvent): void => {
    if (!root.contains(event.target as Node)) {
      dismiss();
    }
  };

  const rows = (): HTMLButtonElement[] =>
    Array.from(list.querySelectorAll<HTMLButtonElement>('button.selection-row'));

  const row = (title: string, detail: string, run: () => void): HTMLButtonElement => {
    const button = el('button', 'selection-row');
    button.type = 'button';
    button.appendChild(el('span', 'row-title', title));
    if (detail !== '') {
      button.appendChild(el('span', 'row-detail', detail));
    }
    button.addEventListener('click', () => {
      close();
      run();
    });
    return button;
  };

  const renderRows = (prompts: readonly PromptEntry[]): void => {
    list.textContent = '';
    for (const prompt of prompts) {
      if (prompt.body === '') {
        continue;
      }
      const button = row(prompt.title, prompt.description, () => options.onAsk(prompt.body));
      button.title = prompt.path;
      list.appendChild(button);
    }
    if (options.actions.length > 0) {
      if (list.childElementCount > 0) {
        list.appendChild(el('div', 'selection-divider'));
      }
      list.appendChild(el('div', 'selection-group', 'Actions'));
      for (const action of options.actions) {
        list.appendChild(row(action.name, '', () => options.onAction(action.triggerId)));
      }
    }
  };
  renderRows([]);
  void options.prompts.then(
    (prompts) => {
      if (!closed) {
        renderRows(prompts);
        place();
      }
    },
    () => undefined,
  );

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key === 'Enter' && event.target === input) {
      const question = input.value.trim();
      if (question !== '') {
        event.preventDefault();
        close();
        options.onAsk(question);
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    const all = rows();
    if (all.length === 0) {
      return;
    }
    event.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      all[Math.min(at + 1, all.length - 1)].focus();
    } else if (at <= 0) {
      input.focus();
    } else {
      all[at - 1].focus();
    }
  });

  /** Below the anchor when it fits, else above; always inside the viewport. */
  function place(): void {
    const height = root.offsetHeight;
    const left = Math.max(8, Math.min(options.anchor.left, window.innerWidth - WIDTH - 8));
    const below = options.anchor.bottom + 6;
    const top =
      below + height <= window.innerHeight - 8
        ? below
        : Math.max(8, options.anchor.top - 6 - height);
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
  }

  root.style.position = 'fixed';
  root.style.width = `${WIDTH}px`;
  document.body.appendChild(root);
  place();
  document.addEventListener('mousedown', onDown, true);
  open = { close };
  input.focus();
  return close;
}
