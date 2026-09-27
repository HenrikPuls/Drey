# 0056 — Per-paragraph language auto-detection for the inline spellchecker

## Status

Accepted (code-complete, awaiting owner verification)

## Context

The inline spellchecker (ADR-0013) judged every word with **one globally
configured dictionary** (`spellcheck.language`). The owner's notes mix
languages at paragraph granularity — German minutes with English sentences
and quotes — so one of the two languages was always checked against the
wrong dictionary and came back almost entirely "misspelled".

That mismatch is also the trigger of a measured performance problem:
when most of a document is rejected, thousands of words get squiggle
decorations (wavy underlines are expensive for Chromium to rasterize) and
the compound-splitter fallback in `shared/spellcheck.ts` runs per rejected
word. Long notes in a language the dictionary does not cover froze the
app until everything had been checked and painted.

Detection itself must not depend on the dictionaries: they live in the
main process (ADR-0001/ADR-0013), and a statistical classifier is more
robust than "which dictionary accepts more words" for short text — ratio
voting degrades on two-sentence blocks, exactly the granularity wanted
here.

## Decision

**The renderer detects each paragraph's language and the checker groups
the document's words by it.** Concretely:

- **Granularity: the paragraph** — blank-line-delimited blocks, computed
  by `src/app/editor/spellcheck/language-detect.ts` over the already
  scanned text. Wrapped lines and list runs stay one block.
- **Classifier: `franc-min`** (sindresorhus; pure ESM, ~60 kB, 61
  languages, no native code, no dictionary access). Chosen over ratio
  voting (needs the main process and degrades on short blocks) and over
  full `franc`/fastText (bundle weight for no practical gain).
- **Blocks below 6 words use the fallback** — the configured
  `spellcheck.language` — because headings and one-liners carry too
  little trigram signal. `franc`'s `und` verdict does the same.
- **A detected language with no installed dictionary falls back to the
  configured language, silently.** Text in a language the user has no
  dictionary for stays checked (and flagged) by the active dictionary —
  the owner explicitly chose this over suppressing the block or showing
  a hint: "wird als unbekannt geflagged — das ist korrektes Verhalten".
- **New config flag `spellcheck.autoDetect`, default ON.** The
  configured language remains meaningful as the fallback.
- **Plumbing:** the spell IPC channels (`spell:check`, `spell:suggest`,
  `spell:add-word`) carry an optional trailing `language`; the main
  process validates it against the known dictionary ids and falls back to
  the configured one for unknown ids. The renderer verdict/suggestion
  caches were already keyed `<language> <word>` and carry multi-dictionary
  documents unchanged. The `Flagged` record and the suggestion popup
  carry the flagging language, so suggestions and "Add to dictionary"
  land in the right list.

Part of the same decision, from the performance analysis that motivated
it (all numbers measured on the real nspell + splitter):

- **Verdict memo per loaded dictionary** in `electron/spellcheck.ts` — a
  rejected word previously paid up to three `nspell.correct` calls, and
  the compound splitter re-asked the same word and fragments many times;
  the memo makes repeats free. Capped (cleared at 100k entries).
- **`listLanguages()` no longer caches non-active dictionaries.** It
  parsed every installed dictionary just to show the Settings load state,
  leaving all of them resident (the parsed German dictionary alone is
  ~40 MB heap); only the active language earns a cache entry now.
- **Renderer verdict/suggestion caches are bounded** (cleared wholesale
  at 50k / 5k entries) instead of growing without end.

## Consequences

- Mixed de/en notes are checked correctly per paragraph; squiggles in the
  "other" language disappear without the user switching dictionaries.
- The freeze path ("long note in an unconfigured language") is *not*
  eliminated by detection — per the owner's choice those blocks still
  flag — but its usual trigger (unnoticed language mismatch inside an
  otherwise covered note) is gone, and the memo + eviction work removes
  the main-process cost multipliers. The paint cost of very dense
  squiggling remains a known, accepted trade for now.
- `franc-min` covers 61 languages; a note in an uncovered language simply
  uses the fallback. The ISO 639-3 → 639-1 table in
  `language-detect.ts` is hand-written for exactly those 61 codes;
  unmapped codes can never match an installed dictionary, so the failure
  mode of a missing entry is the (safe) fallback, not a wrong match.
- Detection cost is one trigram scan per changed paragraph, cached by
  block text — negligible next to the existing check round.
