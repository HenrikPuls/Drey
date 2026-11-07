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
import { createChatList } from './chat-list.js';
import type { RunningTasks } from './running-tasks.js';
import type { AssistantState } from './state.js';
import { createTargetSwitcher, createTargetThread } from './target-view.js';
import type { TargetController } from './targets.js';
import { MODEL_TARGET } from './targets-model.js';
import { createThread } from './thread.js';

export interface PanelHandle {
  cleanup(): void;
}

export function mountPanel(
  body: HTMLElement,
  api: DreyPluginApi,
  state: AssistantState,
  tasks: RunningTasks,
  targets: TargetController,
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
  chatSwitchButton.title = api.i18n.t('assistant.head.history');
  chatSwitchButton.setAttribute('aria-label', api.i18n.t('assistant.head.history'));
  chatSwitchButton.appendChild(icon('history', 16));
  chatSwitchButton.addEventListener('click', () => chatList.toggle());
  const chatNewButton = el('button', 'chat-new') as HTMLButtonElement;
  chatNewButton.type = 'button';
  chatNewButton.title = api.i18n.t('assistant.head.new_chat');
  chatNewButton.setAttribute('aria-label', api.i18n.t('assistant.head.new_chat'));
  chatNewButton.appendChild(icon('plus', 16));
  chatNewButton.addEventListener('click', () =>
    targets.activeId() === MODEL_TARGET ? state.newChat() : void targets.newThread(),
  );

  // The conversation target switcher (E13-5): Model | Mission Control | 1:1 …,
  // present only while a plugin registered a target.
  // One head row: the chats button, the icon switcher, the title, + for a new chat.
  const switcher = createTargetSwitcher(api, targets);
  const head = el('header', 'assistant-head');
  head.append(chatSwitchButton, switcher.node, chatLabel, chatNewButton);
  body.appendChild(head);
  const chatList = createChatList(state, targets, () => render());

  // -- thread + composer -------------------------------------------------------
  // A chat restarted from a question offers that question again.
  const thread = createThread(api, state, tasks, (question) => {
    composer.setText(question);
    composer.focus();
  });
  body.appendChild(thread.node);
  const targetThread = createTargetThread(api, targets);
  body.appendChild(targetThread.node);
  body.appendChild(targetThread.tray);
  body.appendChild(chatList.node);
  const composer = mountComposer(body, api, state, targets);

  // -- render loop -----------------------------------------------------------
  let lastActive = targets.activeId();
  const render = (): void => {
    // The active chat's title: the live list wins (fresh after every
    // change round), the loaded view's frontmatter is the fallback for
    // a just-created chat the list has not re-read yet.
    const activePath = state.activeChatPath();
    const onTarget = targets.activeId() !== MODEL_TARGET;
    const chatTitle = onTarget
      ? (targets.thread()?.title ?? null)
      : activePath === null
        ? null
        : (state.chats().find((chat) => chat.path === activePath)?.title ??
          state.view()?.frontmatter.title ??
          null);
    chatLabel.textContent = chatList.isOpen() ? 'Chats' : (chatTitle ?? 'New chat');
    chatLabel.title = chatLabel.textContent;
    if (targets.activeId() !== lastActive) {
      lastActive = targets.activeId();
      chatList.close();
    }
    chatSwitchButton.classList.toggle('on', chatList.isOpen());

    switcher.render();
    body.classList.toggle('on-target', onTarget);
    thread.node.hidden = onTarget;
    chatSwitchButton.hidden = onTarget && targets.active()?.history === undefined;
    composer.render();
    thread.render();
    targetThread.render();
    chatList.render();
    if (chatList.isOpen()) {
      thread.node.hidden = true;
      targetThread.node.hidden = true;
      targetThread.tray.hidden = true;
    }
  };
  render();
  const unsubState = state.subscribe(render);
  const unsubTasks = tasks.subscribe(render);
  const unsubTargets = targets.subscribe(render);

  return {
    cleanup: () => {
      unsubState();
      unsubTasks();
      unsubTargets();
      composer.destroy();
    },
  };
}
