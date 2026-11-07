import { ChangeDetectionStrategy, Component, inject, input, output, computed } from '@angular/core';
import type { SessionMeta } from '../api/dto';
import { historyGroupsOf } from '../chat/chat';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { McI18n } from '../i18n/i18n.service';
import { PhoneIcon } from '../phone/icon';
import { chatTimeOf } from './menu';

/** The iPad's left pane while a thread is in the centre (board 10f): the chats by day. */
@Component({
  selector: 'mc-pad-chats',
  imports: [McI18nPipe, PhoneIcon],
  templateUrl: './pad-chats.html',
  styleUrl: './pad-chats.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PadChats {
  private readonly i18n = inject(McI18n);

  readonly sessions = input<readonly SessionMeta[]>([]);
  readonly activeFile = input<string | null>(null);
  readonly now = input<() => number>(() => Date.now());

  readonly openChat = output<SessionMeta>();
  readonly newChat = output<void>();

  protected readonly groups = computed(() => historyGroupsOf(this.sessions(), this.now()(), ''));

  protected age(entry: SessionMeta): string {
    return chatTimeOf(entry.updatedAt, this.now()(), this.i18n);
  }

  protected groupLabel(label: string): string {
    return this.i18n.t(`menu.group.${label.toLowerCase() as 'today' | 'yesterday' | 'earlier'}`);
  }
}
