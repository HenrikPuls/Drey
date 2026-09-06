/**
 * Reads and writes the note assistant's sidecar threads
 * (`.{name}.chat.json`, see `shared/chat-thread.ts`). Thin on purpose: the
 * format and its defensive parsing are shared code, this class only does
 * the file IO through `VaultManager` so the vault escape guard applies to
 * sidecars exactly as it does to notes.
 */
import {
  ChatThread,
  emptyThread,
  parseChatThread,
  serializeChatThread,
  sidecarPathFor,
} from '../shared/chat-thread';
import { VaultManager } from './vault-manager';

export class ChatStore {
  constructor(private readonly vault: VaultManager) {}

  /** The thread for `notePath`, or an empty one when no sidecar exists yet. */
  async read(notePath: string): Promise<ChatThread> {
    try {
      const { content } = await this.vault.readFile(sidecarPathFor(notePath));
      return parseChatThread(content, notePath);
    } catch {
      // No sidecar yet (the common case) or an unreadable one -- either
      // way the panel opens on an empty thread rather than an error.
      return emptyThread(notePath);
    }
  }

  async write(thread: ChatThread): Promise<void> {
    await this.vault.writeFile(sidecarPathFor(thread.notePath), serializeChatThread(thread));
  }
}
