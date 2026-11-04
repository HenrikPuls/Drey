/**
 * The chat list inside the panel (replaces the two modal pickers): the
 * three-lines button in the head swaps the thread for the list of the
 * active target's chats -- the Model's chat notes, or a target's own
 * history -- and a row opens one. Plain DOM over the state and the target
 * controller; it knows no target's content (ADR-0044 rule 2).
 */
import type { ConversationThreadMeta } from '../../../shared/plugin-api/renderer';
import { el } from './dom.js';
import type { AssistantState } from './state.js';
import type { TargetController } from './targets.js';
import { MODEL_TARGET } from './targets-model.js';

export interface ChatList {
  readonly node: HTMLElement;
  isOpen(): boolean;
  toggle(): void;
  close(): void;
  /** Redraws the rows while open. */
  render(): void;
}

/** `2026-11-04T10:15` -> `2026-11-04 10:15`; the list reads newest first, so the stamp stays plain. */
const stampOf = (iso: string | null): string => (iso ?? '').slice(0, 16).replace('T', ' ');

export function createChatList(state: AssistantState, targets: TargetController, onToggle: () => void): ChatList {
  const node = el('div', 'assistant-chatlist');
  node.hidden = true;
  let open = false;
  let rows: readonly ConversationThreadMeta[] = [];
  let loaded = false;

  const close = (): void => {
    if (open) {
      open = false;
      node.hidden = true;
      onToggle();
    }
  };

  const row = (title: string, detail: string, current: boolean, pending: number, openIt: () => void): HTMLElement => {
    const item = el('button', 'assistant-chatlist-row' + (current ? ' current' : '')) as HTMLButtonElement;
    item.type = 'button';
    item.appendChild(el('span', 'assistant-chatlist-title', title));
    if (pending > 0) {
      item.appendChild(el('span', 'relay-chip', `${pending} open`));
    }
    item.appendChild(el('span', 'assistant-chatlist-detail', detail));
    item.title = title;
    item.addEventListener('click', () => {
      openIt();
      close();
    });
    return item;
  };

  const render = (): void => {
    if (!open) {
      return;
    }
    node.textContent = '';
    const onModel = targets.activeId() === MODEL_TARGET;
    if (onModel) {
      const activePath = state.activeChatPath();
      for (const chat of state.chats()) {
        node.appendChild(row(chat.title, stampOf(chat.updated), chat.path === activePath, 0, () => void state.openChat(chat.path)));
      }
      if (state.chats().length === 0) {
        node.appendChild(el('p', 'empty', state.chatsFailed() ? 'Chats could not be listed.' : 'No chats yet.'));
      }
      return;
    }
    const currentId = targets.thread()?.id ?? null;
    for (const entry of rows) {
      node.appendChild(row(entry.title, stampOf(entry.updatedAt), entry.id === currentId, entry.pending ?? 0, () => void targets.openThread(entry.id)));
    }
    if (rows.length === 0) {
      node.appendChild(el('p', 'empty', loaded ? 'No chats yet.' : 'Loading …'));
    }
  };

  const load = (): void => {
    if (targets.activeId() === MODEL_TARGET) {
      state.invalidateChats();
      return;
    }
    loaded = false;
    void targets.history().then((found) => {
      rows = found;
      loaded = true;
      render();
    });
  };

  node.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });

  return {
    node,
    isOpen: () => open,
    toggle: () => {
      open = !open;
      node.hidden = !open;
      if (open) {
        rows = [];
        load();
        render();
      }
      onToggle();
    },
    close,
    render,
  };
}
