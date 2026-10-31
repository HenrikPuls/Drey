/**
 * The fixed shape a fleet worker asks the owner in (req-75 W2, ADR-0087
 * decision 4): a `QUESTION:` turn whose lines are the question, what the
 * ticket is about, where the worker stands, why it asks, two to four
 * numbered options with their consequences, and a recommendation. Parsed
 * in main once (`RunWaiting.shaped`) so the desk and the phone render
 * the same structure; a text that does not follow the shape stays the
 * plain question of req-64. Pure and total: worker output is untrusted
 * text, so the parser never throws and caps every field.
 */

/** One numbered option. `consequence` is null when the line names none. */
export interface ShapedOption {
  readonly n: number;
  readonly label: string;
  readonly consequence: string | null;
}

/** A `QUESTION:` turn parsed into its fixed parts (see `parseShapedQuestion`). */
export interface ShapedQuestion {
  readonly question: string;
  /** The "Ticket:" line. */
  readonly context: string | null;
  /** The "Where:" line. */
  readonly where: string | null;
  /** The "Why:" line. */
  readonly why: string | null;
  /** The numbered options, 2 to 4. */
  readonly options: readonly ShapedOption[];
  /** The recommended option's `n`; null without a valid recommendation. */
  readonly recommended: number | null;
  readonly recommendationWhy: string | null;
}

/** Every field is capped at this length — a worker may ramble. */
const MAX_FIELD = 500;

const cap = (text: string): string => (text.length > MAX_FIELD ? text.slice(0, MAX_FIELD) : text);

/** `Ticket:` / `Where:` / `Why:` / `Options:` / `Recommendation:` — case-insensitive. */
const FIELD_LINE = /^(ticket|where|why|options|recommendation)\s*:\s*(.*)$/i;
/** An option line: `1. …` (also `1) …`). */
const OPTION_LINE = /^(\d{1,2})[.)]\s+(.*)$/;
/** `Recommendation: 1 — why` (also `1.`, `1:`, `1 -`, or a bare space). */
const RECOMMENDATION_LINE = /^(\d{1,2})(?:\s*[.)—:|-]\s*|\s+|$)(.*)$/;
/** What separates an option's label from its consequence. */
const SEPARATORS: readonly string[] = [' — ', ' - ', ': '];

function splitOption(n: number, rest: string): ShapedOption | null {
  let cut = -1;
  let width = 0;
  for (const separator of SEPARATORS) {
    const at = rest.indexOf(separator);
    if (at >= 0 && (cut < 0 || at < cut)) {
      cut = at;
      width = separator.length;
    }
  }
  if (cut < 0) {
    return rest === '' ? null : { n, label: cap(rest), consequence: null };
  }
  const label = rest.slice(0, cut).trim();
  const consequence = rest.slice(cut + width).trim();
  return label === '' ? null : { n, label: cap(label), consequence: consequence === '' ? null : cap(consequence) };
}

/**
 * The text after `QUESTION:`. null unless the first line is non-empty AND
 * there are 2–4 numbered options. Labels are case-insensitive; lines may
 * start with `- `; an option line is `<n>. <label> — <consequence>` (also
 * ` - ` or `: ` as separator; no separator → consequence null).
 * `Recommendation: <n> — <why>` — a recommendation that names no option
 * is dropped. Lines that match nothing are ignored; the parser never
 * throws.
 */
export function parseShapedQuestion(text: string): ShapedQuestion | null {
  try {
    if (typeof text !== 'string') {
      return null;
    }
    const lines = text.split(/\r?\n/);
    const question = (lines[0] ?? '').trim();
    if (question === '') {
      return null;
    }
    let context: string | null = null;
    let where: string | null = null;
    let why: string | null = null;
    const options: ShapedOption[] = [];
    let recommendation: { n: number; why: string | null } | null = null;
    for (const raw of lines.slice(1)) {
      const line = raw.replace(/^-\s+/, '').trimEnd();
      if (line.trim() === '') {
        continue;
      }
      const field = FIELD_LINE.exec(line);
      if (field !== null) {
        const raw = field[2]!.trim();
        const value = cap(raw);
        switch (field[1]!.toLowerCase()) {
          case 'ticket':
            if (context === null && value !== '') {
              context = value;
            }
            break;
          case 'where':
            if (where === null && value !== '') {
              where = value;
            }
            break;
          case 'why':
            if (why === null && value !== '') {
              why = value;
            }
            break;
          case 'options':
            break;
          case 'recommendation': {
            const parsed = RECOMMENDATION_LINE.exec(raw);
            if (parsed !== null) {
              const why = cap(parsed[2]!.trim());
              recommendation = { n: Number(parsed[1]), why: why === '' ? null : why };
            }
            break;
          }
        }
        continue;
      }
      const option = OPTION_LINE.exec(line);
      if (option !== null) {
        const split = splitOption(Number(option[1]), option[2]!.trim());
        if (split !== null) {
          options.push(split);
        }
        continue;
      }
      // Anything else: tolerated, ignored.
    }
    if (options.length < 2 || options.length > 4) {
      return null;
    }
    const valid = recommendation !== null && options.some((o) => o.n === recommendation!.n) ? recommendation : null;
    return {
      question: cap(question),
      context,
      where,
      why,
      options,
      recommended: valid?.n ?? null,
      recommendationWhy: valid !== null ? valid.why : null,
    };
  } catch {
    return null;
  }
}

/** What an option tap sends back to the worker: `<n>. <label>`. */
export function answerText(option: ShapedOption): string {
  return `${option.n}. ${option.label}`;
}
