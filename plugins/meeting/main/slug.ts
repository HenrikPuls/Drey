/**
 * Turns a meeting title into the kebab-case identifier used for its
 * `#mtg/<slug>` tag. Only the *tag* is slugified — the section heading
 * keeps the human title verbatim.
 *
 * Not reused from `shared/llm/classifier.ts` `normalizeTagToken`: that one
 * is locked inside the `shared/llm` barrel, keeps `/` (hierarchy), and has
 * no reply-prefix or length handling. The umlaut transliteration matches
 * it on purpose so `#mtg/…` slugs read the same as LLM-suggested tags.
 */

/** `Re:` / `Fwd:` / `AW:` / `Updated:` … noise Outlook prepends to invite subjects. */
const LEADING_NOISE =
  /^\s*(?:re|fw|fwd|aw|wg|updated|accepted|declined|tentative|canceled|cancelled)\s*:\s*/i;

/** Combining diacritical marks left behind by NFKD decomposition (é -> e + U+0301). */
const COMBINING_MARKS = /[̀-ͯ]/g;

const MAX_LENGTH = 60;

export function slugifyMeetingTitle(title: string): string {
  let text = (title ?? '').toLowerCase();

  // Strip stacked prefixes ("RE: FW: Weekly" -> "weekly").
  let stripped = text.replace(LEADING_NOISE, '');
  while (stripped !== text) {
    text = stripped;
    stripped = text.replace(LEADING_NOISE, '');
  }

  const slug = text
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const capped = capOnBoundary(slug, MAX_LENGTH);
  return capped === '' ? 'meeting' : capped;
}

/** Trims `slug` to at most `max` chars, preferring to cut on a `-` boundary. */
function capOnBoundary(slug: string, max: number): string {
  if (slug.length <= max) {
    return slug;
  }
  const head = slug.slice(0, max);
  const lastDash = head.lastIndexOf('-');
  return (lastDash > 0 ? head.slice(0, lastDash) : head).replace(/-$/, '');
}
