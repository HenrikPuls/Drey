import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ChatService } from '../services/chat.service';
import { Icon } from '../icons/icon';

/**
 * The sticky input bar pinned to the bottom of the main area: a text field
 * plus a "this document" / "all notes" scope toggle and a send button.
 *
 * Milestone "visual shell" wires the field and the toggle (state in
 * `ChatService`); actually sending -- keyword search, then chat -- is a
 * later Phase-1 step, so the button is disabled until there's a query and
 * `submit()` is a no-op for now.
 */
@Component({
  selector: 'app-chat-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './chat-input.html',
  styleUrl: './chat-input.css',
})
export class ChatInput {
  protected readonly chat = inject(ChatService);

  protected onInput(event: Event): void {
    this.chat.setQuery((event.target as HTMLTextAreaElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.chat.submit();
    }
  }
}
