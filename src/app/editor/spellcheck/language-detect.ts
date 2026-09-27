/**
 * Per-paragraph language auto-detection for the inline spellchecker
 * (ADR-0056). Notes frequently mix languages -- German minutes with an
 * English sentence, a quoted passage -- and one global dictionary then
 * flags half of the text as wrong. This module splits a scanned text into
 * paragraphs, detects each paragraph's language with `franc` (a
 * statistical trigram classifier, no dictionary access needed), and maps
 * that onto a dictionary the user actually has installed.
 *
 * Policy, deliberately conservative:
 * - Blocks below a word-count floor use the fallback language (the
 *   configured dictionary): a heading or a one-line list carries far too
 *   little signal for trigram statistics to be trustworthy.
 * - `franc`'s `und` (undetermined) falls back, too.
 * - A detected language with no installed dictionary falls back as well,
 *   so text in a language the user has no dictionary for stays checked
 *   against the configured one -- flagged, which is the pre-detection
 *   behaviour and what the owner asked the fallback to keep doing.
 *
 * Everything here is pure and synchronous; the per-block verdict cache is
 * the caller's (the renderer `SpellcheckService`) concern and lives in
 * `createLanguageDetector`.
 */
import { franc } from 'franc-min';

/** A paragraph's extent in the scanned text. */
export interface BlockRange {
  from: number;
  to: number;
}

/**
 * Blank-line-delimited paragraph ranges of `text`, in document order.
 * Consecutive non-blank lines belong to one block (wrapped paragraphs,
 * list items), so detection sees the full context of a logical paragraph.
 * Leading and trailing blank runs produce no empty blocks.
 */
export function paragraphRanges(text: string): BlockRange[] {
  const out: BlockRange[] = [];
  let start = -1;
  for (const match of text.matchAll(LINE_RE)) {
    const line = match[0];
    const at = match.index;
    const hasNewline = line.endsWith('\n');
    const body = hasNewline ? line.slice(0, -1) : line;
    if (body.trim() === '') {
      if (start >= 0) {
        out.push({ from: start, to: at });
        start = -1;
      }
    } else if (start < 0) {
      start = at;
    }
  }
  if (start >= 0) {
    out.push({ from: start, to: text.length });
  }
  return out;
}

/** The block `offset` lies in, or null when it falls between blocks. */
export function blockAt(ranges: readonly BlockRange[], offset: number): BlockRange | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (offset < range.from) {
      high = mid - 1;
    } else if (offset >= range.to) {
      low = mid + 1;
    } else {
      return range;
    }
  }
  return null;
}

/** One line of the scanned text, including its newline if it has one. */
const LINE_RE = /[^\n]*\n|[^\n]+$/g;

/** `de-AT` -> `de`, `fr_FR` -> `fr` -- how dictionary ids carry a region. */
export function primarySubtag(id: string): string {
  return id.split(/[-_]/, 1)[0].toLowerCase();
}

/**
 * franc-min's languages (ISO 639-3) that have an ISO 639-1 equivalent.
 * Codes absent here (Cebuano, Hmong Njua, ...) can never match an
 * installed dictionary id, so they need no entry -- they fall through to
 * the fallback language.
 */
const ISO3_TO_ISO1: Readonly<Record<string, string>> = {
  arb: 'ar',
  azj: 'az',
  bel: 'be',
  bos: 'bs',
  bul: 'bg',
  ces: 'cs',
  deu: 'de',
  eng: 'en',
  fra: 'fr',
  hau: 'ha',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ibo: 'ig',
  ind: 'id',
  ita: 'it',
  jav: 'jv',
  kaz: 'kk',
  kin: 'rw',
  lin: 'ln',
  mar: 'mr',
  nld: 'nl',
  npi: 'ne',
  pes: 'fa',
  plt: 'mg',
  pol: 'pl',
  por: 'pt',
  ron: 'ro',
  run: 'rn',
  rus: 'ru',
  som: 'so',
  spa: 'es',
  srp: 'sr',
  sun: 'su',
  swe: 'sv',
  swh: 'sw',
  tgl: 'tl',
  tur: 'tr',
  ukr: 'uk',
  urd: 'ur',
  uzn: 'uz',
  vie: 'vi',
  yor: 'yo',
  zlm: 'ms',
  zul: 'zu',
};

/** Blocks with fewer words than this go to the fallback language. */
const MIN_BLOCK_WORDS = 6;

/** The detector's block cache clears once it holds this many entries. */
const CACHE_LIMIT = 2_000;

/** What `createLanguageDetector` needs from the app config. */
export interface DetectorOptions {
  /** The language to use when detection cannot answer confidently. */
  fallback(): string;
  /** Ids of the dictionaries the user actually has (bundled + custom). */
  installed(): readonly string[];
}

export interface LanguageDetector {
  /**
   * The dictionary id to check `block` with. Pure function of the block
   * text plus the detector's options -- results are cached, so repeated
   * checks of an unchanged paragraph pay one Map lookup.
   */
  languageFor(block: string): string;
  /** Drops the block cache (config changed: language or dictionaries). */
  invalidate(): void;
}

/**
 * Maps a franc verdict onto an installed dictionary id: an exact id match
 * wins over a shared primary subtag ("de" before "de-AT" for `deu`).
 * Returns null when no installed dictionary matches.
 */
export function matchInstalled(
  iso3: string,
  installed: readonly string[],
): string | null {
  const iso1 = ISO3_TO_ISO1[iso3];
  if (iso1 === undefined) {
    return null;
  }
  const exact = installed.find((id) => id.toLowerCase() === iso1);
  if (exact !== undefined) {
    return exact;
  }
  return installed.find((id) => primarySubtag(id) === iso1) ?? null;
}

export function createLanguageDetector(options: DetectorOptions): LanguageDetector {
  const cache = new Map<string, string>();
  return {
    languageFor(block: string): string {
      const cached = cache.get(block);
      if (cached !== undefined) {
        return cached;
      }
      let language = options.fallback();
      const words = block.match(/\p{L}+/gu);
      if (words !== null && words.length >= MIN_BLOCK_WORDS) {
        const iso3 = franc(block);
        const installed = matchInstalled(iso3, options.installed());
        if (installed !== null) {
          language = installed;
        }
      }
      if (cache.size >= CACHE_LIMIT) {
        cache.clear();
      }
      cache.set(block, language);
      return language;
    },
    invalidate(): void {
      cache.clear();
    },
  };
}
