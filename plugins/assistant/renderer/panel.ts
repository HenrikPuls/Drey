/**
 * The assistant panel's DOM (ADR-0044 rule 2: plugin UI is plain DOM).
 * Chat-first since ADR-0048: a chat picker + "New chat" in the head, the
 * thread of turn cards (`thread.ts`) and the milestone-24 composer
 * (`composer.ts`). This file assembles the three and runs the render
 * loop; the pickers are the `picker-*.ts` files.
 *
 * Deliberate divergences from the old Angular panel, recorded in the
 * stage-7 notes and kept here:
 * - the composer is a bare host CodeMirror view (the host's instances via
 *   `api.editor.cm`), so the inline spellchecker (a base Angular service)
 *   does not run here;
 * - a manual Action's noop/error message shows as a quiet line in the panel
 *   (it used to sit in the editor meta bar, which is base UI);
 * - the @-completion opens on a bare `@`: in a one-line composer the popup
 *   IS the affordance.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { mountComposer } from './composer.js';
import { el, icon } from './dom.js';
import { openChatPicker } from './picker-chat.js';
import type { RunningTasks } from './running-tasks.js';
import type { AssistantState } from './state.js';
import { createThread } from './thread.js';

export interface PanelHandle {
  cleanup(): void;
}

export function mountPanel(
  body: HTMLElement,
  api: DreyPluginApi,
  state: AssistantState,
  tasks: RunningTasks,
): PanelHandle {
  body.classList.add('assistant-panel');

  // -- head: the chat selector -----------------------------------------------
  // Icon-only controls (ADR-0057) + the active chat's title as a muted
  // label (57e): it reads from the live chat list (and the loaded view as
  // a fallback), so it is never stale — the model-named title replaces
  // the question placeholder through the change round.
  const chatLabel = el('span', 'chat-label');
  const chatSwitchButton = el('button', 'chat-switch') as HTMLButtonElement;
  chatSwitchButton.type = 'button';
  chatSwitchButton.title = 'Switch chat';
  chatSwitchButton.setAttribute('aria-label', 'Switch chat');
  chatSwitchButton.appendChild(icon('list', 13));
  chatSwitchButton.addEventListener('click', () => openChatPicker(api, state));
  const chatNewButton = el('button', 'chat-new') as HTMLButtonElement;
  chatNewButton.type = 'button';
  chatNewButton.title = 'Start a new chat';
  chatNewButton.setAttribute('aria-label', 'Start a new chat');
  chatNewButton.appendChild(icon('plus', 13));
  chatNewButton.addEventListener('click', () => state.newChat());

  const head = el('header', 'assistant-head');
  const chatHead = el('div', 'chat-head');
  chatHead.append(chatLabel, chatSwitchButton, chatNewButton);
  head.append(chatHead);
  body.appendChild(head);

  // -- thread + composer -------------------------------------------------------
  // A chat restarted from a question offers that question again.
  const thread = createThread(api, state, tasks, (question) => {
    composer.setText(question);
    composer.focus();
  });
  body.appendChild(thread.node);
  const composer = mountComposer(body, api, state);

  // -- render loop -----------------------------------------------------------
  const render = (): void => {
    // The active chat's title: the live list wins (fresh after every
    // change round), the loaded view's frontmatter is the fallback for
    // a just-created chat the list has not re-read yet.
    const activePath = state.activeChatPath();
    const chatTitle =
      activePath === null
        ? null
        : (state.chats().find((chat) => chat.path === activePath)?.title ??
          state.view()?.frontmatter.title ??
          null);
    chatLabel.textContent = chatTitle ?? 'New chat';
    chatLabel.title = chatTitle ?? 'New chat';

    composer.render();
    thread.render();
  };
  render();
  const unsubState = state.subscribe(render);
  const unsubTasks = tasks.subscribe(render);

  return {
    cleanup: () => {
      unsubState();
      unsubTasks();
      composer.destroy();
    },
  };
}
