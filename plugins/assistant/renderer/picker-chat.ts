import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { el } from './dom.js';
import { pickerFrame, showPicker } from './picker-frame.js';
import type { AssistantState } from './state.js';

/** The chat picker: "New chat" above every chat note, the active one marked. */
export function openChatPicker(api: DreyPluginApi, state: AssistantState): void {
  let close: () => void = () => undefined;
  let unsubscribe: (() => void) | null = null;

  const closePicker = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    close();
  };

  const { box, bodyArea } = pickerFrame('Chats');

  const listBox = el('div', 'assistant-picker-list');
  const newRow = el('div', 'assistant-picker-row new-chat', 'New chat');
  newRow.addEventListener('click', () => {
    state.newChat();
    closePicker();
  });
  listBox.appendChild(newRow);

  const renderList = (): void => {
    // Rebuild everything below the "New chat" row: this also runs when
    // the (async) list lands or changes while the picker sits open.
    for (const row of listBox.querySelectorAll('.assistant-picker-row:not(.new-chat), .assistant-picker-empty')) {
      row.remove();
    }
    for (const chat of state.chats()) {
      const rowEl = el(
        'div',
        'assistant-picker-row' + (chat.path === state.activeChatPath() ? ' current' : ''),
        chat.title,
      );
      rowEl.appendChild(
        el('span', 'assistant-picker-detail', (chat.updated ?? '').slice(0, 16).replace('T', ' ')),
      );
      rowEl.title = chat.path;
      rowEl.addEventListener('click', () => {
        void state.openChat(chat.path);
        closePicker();
      });
      listBox.appendChild(rowEl);
    }
    if (state.chats().length === 0) {
      listBox.appendChild(
        el(
          'div',
          'assistant-picker-empty',
          state.chatsFailed()
            ? 'Chats could not be listed.'
            : 'No chats yet — the first question creates one.',
        ),
      );
    }
  };
  renderList();
  bodyArea.appendChild(listBox);

  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePicker();
    }
  });

  close = showPicker(api, box);
  unsubscribe = state.subscribe(renderList);
  void state.invalidateChats();
}
