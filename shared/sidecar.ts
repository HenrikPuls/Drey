/**
 * The note assistant's sidecar filename rule, kept BASE on purpose: the
 * thread *store* lives in the assistant plugin (`plugins/assistant/`,
 * ADR-0044 stage 7), but the sidecar's *lifecycle* is filesystem work the
 * base `VaultManager` does anyway — a delete/rename/copy of a note moves
 * the sidecar with it, or the plugin's thread would be orphaned.
 *
 * Kept byte-compatible with the plugin's copy in
 * `plugins/assistant/shared/chat-thread.ts`; if you change one, change
 * both.
 */

/** `daily/2026-09-26.md` -> `daily/.2026-09-26.chat.json`. */
export function sidecarPathFor(notePath: string): string {
  const slash = notePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : notePath.slice(0, slash + 1);
  const file = notePath.slice(slash + 1);
  const base = file.replace(/\.md$/i, '');
  return `${dir}.${base}.chat.json`;
}
