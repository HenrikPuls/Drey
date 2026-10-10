/**
 * The palette's matcher (milestone 59): a case-insensitive subsequence
 * match with a score -- every query character must appear in order, and
 * the score rewards what a person means by a "good" match: a run of
 * consecutive characters, a hit at the start of a word, a match that
 * begins early. Hand-rolled (some 40 lines) rather than a dependency: the
 * candidate sets are a vault's file list and a few dozen commands.
 */

const WORD_BREAK = /[\s/\\._-]/;

/** The match score of `query` in `text` (higher is better), or null when it does not match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === '') {
    return 0;
  }
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const ch of q) {
    if (ch === ' ') {
      continue;
    }
    const found = t.indexOf(ch, at);
    if (found === -1) {
      return null;
    }
    score += 1;
    if (found === previous + 1) {
      score += 5;
    }
    if (found === 0 || WORD_BREAK.test(t[found - 1])) {
      score += 8;
    } else if (text[found] !== t[found] && text[found - 1] === t[found - 1]) {
      // A capital inside a camelCase word starts a word too.
      score += 6;
    }
    // Skipped characters cost a little -- tighter matches rank higher.
    score -= Math.min(3, (found - at) * 0.2);
    previous = found;
    at = found + 1;
  }
  // The whole query as one substring beats any scattered match.
  if (t.includes(q)) {
    score += 12;
  }
  return score - t.length * 0.01;
}

/** `items` matching `query`, best first; ties keep their incoming order. */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  score: (item: T, query: string) => number | null,
  limit: number,
): T[] {
  if (query.trim() === '') {
    return items.slice(0, limit);
  }
  const scored: Array<{ item: T; score: number; order: number }> = [];
  items.forEach((item, order) => {
    const s = score(item, query);
    if (s !== null) {
      scored.push({ item, score: s, order });
    }
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((entry) => entry.item);
}
