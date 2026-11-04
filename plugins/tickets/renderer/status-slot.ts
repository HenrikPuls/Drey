/**
 * The pure half of the tickets plugin's status-bar item (SDK 1.38):
 * "2 running · 3 need you" from the fleet's live runs and the board's
 * needs-you count. Empty text means the item is hidden.
 */
export function statusSlotText(running: number, needsYou: number): string {
  const parts: string[] = [];
  if (running > 0) {
    parts.push(`${running} running`);
  }
  if (needsYou > 0) {
    parts.push(`${needsYou} need you`);
  }
  return parts.join(' · ');
}
