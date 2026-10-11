/**
 * Finds the "join online meeting" link in a decoded invite. Outlook stores
 * it in any of several `X-` properties for `.ics`, and only in the body /
 * location for `.msg`, so this takes every candidate string and returns
 * the first plausible `http(s)` URL — preferring a known conferencing host.
 */

// Not anchored: in a mail body the link sits somewhere in the text.
const CONFERENCING_HOST =
  /https?:\/\/[^\s"'<>]*\b(?:teams\.microsoft\.com|teams\.live\.com|zoom\.us|meet\.google\.com|webex\.com|gotomeeting\.com|whereby\.com)\b[^\s"'<>]*/i;

const ANY_URL = /https?:\/\/[^\s"'<>)\]]+/i;

/** `candidates` in priority order (dedicated join fields first, then location, then body). */
export function findJoinUrl(candidates: Array<string | null | undefined>): string | null {
  const texts = candidates.filter((value): value is string => !!value && value.trim() !== '');

  for (const text of texts) {
    const conferencing = text.match(CONFERENCING_HOST);
    if (conferencing) {
      return trimTrailingPunctuation(conferencing[0]);
    }
  }
  for (const text of texts) {
    const any = text.match(ANY_URL);
    if (any) {
      return trimTrailingPunctuation(any[0]);
    }
  }
  return null;
}

/** URLs pulled from prose often carry a trailing `.` / `,` / `>` — drop it. */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:>]+$/, '');
}
