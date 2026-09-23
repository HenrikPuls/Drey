/**
 * The dictionary side of the inline spellchecker. Lives in the main
 * process for two reasons: the Hunspell dictionaries are files on disk
 * (the renderer has no filesystem access, ADR-0001), and a loaded
 * dictionary is a multi-megabyte object that should exist once per app,
 * not once per editor surface.
 *
 * `nspell` is a pure-JS Hunspell implementation, so there is no native
 * module to rebuild per Electron version -- the reason it is preferred
 * here over a `nodehun`-style binding. German and English ship with the
 * app (`dictionary-de` / `dictionary-en`); anything else the user adds in
 * Settings is read from a `.aff`/`.dic` pair on disk.
 *
 * Everything is lazy and failure-tolerant: a dictionary that cannot be
 * loaded yields "no issues" rather than an exception, because a broken
 * checker must never break typing.
 */
import * as fsp from 'node:fs/promises';
import { BUNDLED_DICTIONARIES, CustomDictionary } from '../shared/app-config';
import { SpellCheckResult, SpellLanguage } from '../shared/ipc-api';
import { compoundAcceptable, compoundSuggestions, editDistance, personalDictionaryFor } from '../shared/spellcheck';
import { AppConfigStore } from './app-config';

// nspell ships no type declarations; the surface used here is small
// enough to describe locally rather than pull in a `@types` package.
interface NSpell {
  correct(word: string): boolean;
  suggest(word: string): string[];
  /** Accepts a newline list of extra words (`shared/spellcheck.ts`). */
  personal(dictionary: string): NSpell;
}
type NSpellFactory = (aff: Uint8Array | string, dic: Uint8Array | string) => NSpell;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nspell = require('nspell') as NSpellFactory;

/** How many suggestions the popup offers. More than a few is a wall of text. */
const MAX_SUGGESTIONS = 5;

interface LoadedDictionary {
  spell: NSpell | null;
  error?: string;
}

export class SpellcheckService {
  /** Loaded (or failed) dictionaries by language id. */
  private readonly cache = new Map<string, LoadedDictionary>();

  constructor(private readonly config: AppConfigStore) {}

  /** Bundled + custom dictionaries, with their load state (Settings pane). */
  async listLanguages(): Promise<SpellLanguage[]> {
    const custom = this.config.get().spellcheck.dictionaries;
    const out: SpellLanguage[] = [];
    for (const bundled of BUNDLED_DICTIONARIES) {
      const loaded = await this.load(bundled.id);
      out.push({
        id: bundled.id,
        label: bundled.label,
        builtin: true,
        loaded: loaded.spell !== null,
        ...(loaded.error ? { error: loaded.error } : {}),
      });
    }
    for (const entry of custom) {
      const loaded = await this.load(entry.id);
      out.push({
        id: entry.id,
        label: entry.label,
        builtin: false,
        loaded: loaded.spell !== null,
        ...(loaded.error ? { error: loaded.error } : {}),
      });
    }
    return out;
  }

  /**
   * The words of `words` the active dictionary rejects. Deliberately
   * carries no suggestions: generating them costs tens of milliseconds
   * per misspelled word (the bulk check sends dozens of words after every
   * typing pause / tab open), so they are computed on demand in `suggest`
   * when the user actually clicks a flagged word. Returns an empty list
   * when spellcheck is off or the dictionary is unavailable -- never throws.
   */
  async check(words: readonly string[]): Promise<SpellCheckResult> {
    const settings = this.config.get().spellcheck;
    if (!settings.enabled || words.length === 0) {
      return { language: settings.enabled ? settings.language : '', misspelled: [] };
    }
    const { spell } = await this.load(settings.language);
    if (!spell) {
      return { language: settings.language, misspelled: [] };
    }

    const misspelled: string[] = [];
    for (const word of words) {
      if (this.accepts(spell, word)) {
        continue;
      }
      misspelled.push(word);
    }
    return { language: settings.language, misspelled };
  }

  /**
   * Suggestions for one misspelled word, fetched when its popup opens.
   * Suggest is the expensive nspell operation (tens of ms), which is why
   * it lives here rather than in the bulk `check` -- paid once per click,
   * cached renderer-side afterwards. `[]` for a word that is accepted by
   * now (added to a dictionary between flag and click) or when the
   * dictionary is unavailable.
   */
  async suggest(word: string): Promise<string[]> {
    const settings = this.config.get().spellcheck;
    if (!settings.enabled) {
      return [];
    }
    const { spell } = await this.load(settings.language);
    if (!spell || this.accepts(spell, word)) {
      return [];
    }
    const has = (w: string): boolean => this.accepts(spell, w);
    // nspell's suggest occasionally returns candidates it never checked
    // against the dictionary (ngram noise like "Krankeinbaus"), which
    // would crowd out the good recombination below -- so plain results
    // pass the same acceptance filter as everything else.
    const plain = spell.suggest(word).filter(has).slice(0, MAX_SUGGESTIONS);
    if (plain.length >= MAX_SUGGESTIONS) {
      return plain;
    }
    // A rejected compound leaves the dictionary's own suggest empty --
    // neither the typo nor its correction is a dictionary word. The
    // splitter rebuilds candidates from the one half the dictionary can
    // advise on (shared/spellcheck.ts). The extra suggest calls are
    // per-fragment tens of ms, acceptable here: this runs once per
    // clicked squiggle and the renderer caches the answer.
    const synthesized = compoundSuggestions((w) => spell.suggest(w), has, word);
    // Rank by edit distance to the flagged word: nspell's suggest order
    // is unreliable exactly where the recombination kicks in, and the
    // closest correction is the one the user wants on top.
    const merged = [...new Set([...plain, ...synthesized])];
    merged.sort((a, b) => editDistance(a, word) - editDistance(b, word));
    return merged.slice(0, MAX_SUGGESTIONS);
  }

  /** Accepts `word`, tolerating a case mismatch and German compounds. */
  private accepts(spell: NSpell, word: string): boolean {
    // A word that only fails on capitalisation ("montag" at the start of
    // a sentence is fine, "Montag" mid-sentence is too) is not worth a
    // squiggle -- offsets carry no sentence context up here.
    if (spell.correct(word) || spell.correct(capitalize(word)) || spell.correct(word.toLowerCase())) {
      return true;
    }
    // nspell does not evaluate the German dictionary's COMPOUND* rules,
    // so every closed compound not literally listed would be flagged;
    // the splitter accepts "Testfall" as "Test" + "Fall" (see
    // shared/spellcheck.ts).
    return compoundAcceptable((w) => spell.correct(w) || spell.correct(capitalize(w)) || spell.correct(w.toLowerCase()), word);
  }

  /** Drops cached dictionaries; called after the config changed. */
  invalidate(): void {
    this.cache.clear();
  }

  private async load(language: string): Promise<LoadedDictionary> {
    const cached = this.cache.get(language);
    if (cached) {
      return cached;
    }
    let loaded: LoadedDictionary;
    try {
      const custom = this.config
        .get()
        .spellcheck.dictionaries.find((entry) => entry.id === language);
      const files = custom
        ? await readPair(custom.affPath, custom.dicPath)
        : await loadBundled(language);
      const spell = nspell(files.aff, files.dic);
      const personal = personalDictionaryFor(this.config.get().spellcheck, language);
      if (personal !== '') {
        spell.personal(personal);
      }
      loaded = { spell };
    } catch (err) {
      loaded = { spell: null, error: err instanceof Error ? err.message : String(err) };
    }
    this.cache.set(language, loaded);
    return loaded;
  }
}

/**
 * `dictionary-de` / `dictionary-en` are ESM-only packages whose default
 * export is `{aff, dic}`; a dynamic `import()` is how a CommonJS main
 * process reaches them.
 */
async function loadBundled(language: string): Promise<{ aff: Uint8Array; dic: Uint8Array }> {
  const specifier =
    language === 'en' ? 'dictionary-en' : language === 'de' ? 'dictionary-de' : null;
  if (!specifier) {
    throw new Error(`Unknown dictionary: ${language}`);
  }
  const module = (await import(specifier)) as { default: { aff: Uint8Array; dic: Uint8Array } };
  return module.default;
}

async function readPair(
  affPath: string,
  dicPath: string,
): Promise<{ aff: Uint8Array; dic: Uint8Array }> {
  const [aff, dic] = await Promise.all([fsp.readFile(affPath), fsp.readFile(dicPath)]);
  return { aff, dic };
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
