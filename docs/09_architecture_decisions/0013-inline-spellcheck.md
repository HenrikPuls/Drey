# 13. Inline spellcheck: nspell dictionaries in main, decorations in CodeMirror

## Status

Accepted — implemented with the entry drawer (Feature B).

## Context

The entry drawer needs a spellchecker that behaves like a native one:
misspelled words underlined with a red wavy line _in the text_, and a click
on such a word offering corrections. An earlier draft of the feature listed
the errors separately, below the field — that was dropped because a list
makes you match words to positions by eye.

Two things had to be decided: where the dictionary comes from, and how the
underlines get drawn.

**Dictionary options considered:**

1. **Chromium's built-in spellchecker.** Free — `spellcheck="true"` on the
   CodeMirror content element and Chromium underlines German for you. But
   its suggestions are reachable _only_ through the native right-click
   menu (`params.dictionarySuggestions`); there is no API to ask it about a
   word. No left-click popup, no control over styling.
2. **A native Hunspell binding** (`nodehun`). Fast, but a native module
   must be rebuilt per Electron version — a build-toolchain dependency the
   project has so far avoided entirely.
3. **`nspell`** — Hunspell reimplemented in pure JavaScript, with the
   `dictionary-*` packages providing the `.aff`/`.dic` pairs.
4. **The local LLM.** No dependency, but slow, non-deterministic, and dead
   whenever LLM features are off.

## Decision

**`nspell` + `dictionary-de` / `dictionary-en`, loaded in the main
process.** Pure JS, so nothing to rebuild per Electron version; real
Hunspell dictionaries, so the suggestions are usable ("besprchen" →
"besprochen"). The dictionary files are read from disk and a loaded
dictionary is several megabytes, so both belong on the main side of
ADR-0001 — one instance per app, not one per editor surface.

The `dictionary-*` packages are ESM-only; the CommonJS main process reaches
them with a dynamic `import()`, which `module: Node16` preserves rather
than downlevelling to `require`.

**Further dictionaries are user-addable** (Settings → Spelling):
the picker takes a Hunspell `.dic` and pairs it with the `.aff` of the same
name beside it — the layout every Hunspell distribution ships — so one
pick is enough. Entries are stored as absolute paths in the app config, not
copied into the app; a dictionary whose folder has moved is listed as _cannot be loaded_ rather than silently checking nothing. The active language is a
single config field, so the checker is never in more than one language at a
time.

**Drawing is a CodeMirror 6 extension**
(`src/app/editor/spellcheck/spellcheck.ts`), not Chromium's:

- A `StateField` holds the decorations _and_ the flagged words, so both
  survive edits and move with the text (`RangeSet.map`). Recomputing on
  every keystroke would flicker and misplace underlines while a check is in
  flight.
- Checking is async (it crosses the IPC boundary), so results arrive as a
  `StateEffect`. A `ViewPlugin` debounces the request and version-guards
  the reply — an answer the document has moved past is dropped.
- The plugin re-checks on a document change **and** on an explicit
  `requestSpellcheck(view)`. The second one is not optional: the gate below
  can flip while the text sits still (type the body, _then_ fill in the
  topic), and CodeMirror gives the plugin no way to observe that. Without
  it the underlines only appeared after the next keystroke — found by
  driving the built app, not by the unit tests, which is why there is now a
  regression test for exactly that sequence.
- The popup uses CodeMirror's own `showTooltip` facet, which already
  handles flipping at the window edge and staying attached while scrolling.
- The extension takes a `SpellcheckSource` interface and knows nothing
  about IPC, which is what makes it unit-testable without Electron.

**What gets checked** is decided by pure shared code
(`shared/spellcheck.ts`): fenced and inline code, frontmatter, `#tags`,
`[[wiki links]]`, URLs, link targets and HTML are masked out; acronyms and
single letters are skipped; hyphenated compounds are split and checked
part by part. That last rule matters in German — no dictionary lists
`Rollout-Plan`, and underlining correct text is the fastest way to get a
spellchecker switched off for good.

_(Update: closed compounds are accepted by a splitter, not the
dictionary.)_ The bundled German dictionary declares Hunspell's
`COMPOUND*` rules (`COMPOUNDBEGIN/MIDDLE/END`, `COMPOUNDMIN 2`), but
nspell — a partial Hunspell reimplementation — never evaluates them, so
every closed compound not literally listed was flagged: `Testfall`,
`Krankenhaus`, `Arbeitsspeicher`, the bread and butter of German notes.
Measured before the fix, 20 of 22 everyday compounds came back flagged.
The verdict therefore falls back to `compoundAcceptable`
(`shared/spellcheck.ts`): a rejected word counts as correct when it
decomposes into accepted parts, consuming Fugenelemente (`Arbeit` + `s` +
`Speicher`). The trade-off is deliberate and errs towards silence — every
concatenation of valid words (`Hausbaum`) is accepted too, because a
missed squiggle annoys far less than a wrong one on correct text. The
splitter only runs for words the dictionary rejected outright and each
verdict is cached renderer-side, so the cost is a handful of ~µs lookups
per new unknown word.

**It checks from the first word, everywhere you type** — the entry drawer
and the document editor both. An earlier version gated the drawer on the
entry being "anchored" to a topic, person or meeting; in use that was
wrong. The squiggles showed up late and looked broken, and nobody expects a
spellchecker to wait for metadata before doing its job. Removed on the
project owner's call.

Past `FULL_SCAN_LIMIT` (60 kB) the editor checks the **visible ranges**
only, snapped out to whole lines, instead of the whole document on every
typing pause. Below that it scans everything, which is what you want: the
squiggle is already there when you scroll to it, and the syntax masking
sees complete code fences and frontmatter.

_(Update: suggestions are fetched lazily, per clicked word.)_ Measured
with the real German dictionary, nspell's `correct()` costs ~5 µs per word
while `suggest()` costs **40–108 ms per misspelled word** — computing
suggestions eagerly inside the bulk `spell:check` turned the first check
of a document (open, session restore, after every `invalidate()`) into
seconds of synchronous main-process blocking. `spell:check` therefore
returns only the misspelled words, and a separate `spell:suggest` IPC
channel fetches the popup's suggestions when the user actually clicks a
squiggle; the popup opens immediately with a placeholder row and fills in
place (guarded, so a stale answer never lands in a re-opened popup). The
renderer caches fetched suggestions per language alongside the verdicts.

_(Update: compound typos get synthesized suggestions.)_ nspell's suggest
searches the dictionary's words — and for a flagged compound, neither the
typo nor its correction is one, so the popup showed "No suggestions" for
a squiggle that was entirely justified. `compoundSuggestions`
(`shared/spellcheck.ts`) walks the same split positions as the verdict
splitter, finds cuts where exactly one half is accepted, asks the
dictionary for suggestions of the broken half alone, and re-joins the
results into whole-word candidates (`Krankehnhaus` → `kranken` + `haus`).
Merged candidates are ranked by edit distance to the flagged word, which
is what keeps nspell's unvalidated ngram noise behind the real fix. The
honest boundary: a typo that crosses the part boundary with no accepted
anchor half (a garbled `Schreibtsich` whose `schreib|tisch` split needs a
word the dictionary does not list) yields nothing useful — and
`Testfhal` suggests `Testfahl` (distance 1) before `Testfall`. A real
Hunspell engine would close both gaps; the measured options
(`hunspell-asm` WASM, 4.9 MB, unmaintained since 2020; `nodehun` native,
also unmaintained and breaking the no-native-modules rule) are recorded
here as the escalation path should everyday quality demand it.

**This is the only spellchecker in the app.** Chromium's native checker is
switched off for the whole window (`webPreferences.spellcheck: false`,
`electron/main.ts`). Left on, it also underlines every plain
`<input>`/`<textarea>` — and it does so in its own default language
(`en-US` on Windows, never the configured one), with corrections reachable
only through a context menu the app does not build. The result was a field
that flagged German as wrong and offered no way to fix a word. Off, there
is exactly one spellcheck, one dictionary setting, and one correction
gesture (the left-click popup) everywhere.

For that to hold, every place you write prose is the shared
`MarkdownSurface`: the document editor, the entry drawer body, **and the
note assistant's question composer** (previously a bare `<textarea>`, now
the compact surface with `[spellcheck]` and a `readOnly` input for the
"no note open" state). The drawer's TOPIC field and its Tags chip input
stay plain inputs with no spellcheck at all — a tag is not prose, and
underlining it is noise, not a feature.

_(Update, milestone 11.3: with the tag rebuild
([ADR-0017](0017-tags-as-labels-and-section-index.md)) the drawer's
People and Meetings chip rows are gone — a person or meeting is written
as an ordinary `#tag`. `EntryDraft` is `{ topic, text, tags }`. TOPIC is
now optional with no inline "empty topic?" confirmation; an empty topic
is normal.)_

## Consequences

- ~4 MB of dictionary data joins the dependency tree, and `nspell` +
  `dictionary-de` + `dictionary-en` are three new packages. Accepted for a
  feature that has to work offline.
- German Hunspell flags English loanwords the user's notes are full of
  ("Rollout", "Sync"). Addressed by two accepted-word lists in
  `SpellcheckConfig` — `personalWords` (applied to every dictionary) and
  `languageWords[<id>]` (one dictionary) — merged by
  `personalDictionaryFor` and handed to `nspell.personal()` in
  `SpellcheckService.load()`. Words are added from the correction popup
  (immediate, via the `spell:add-word` IPC channel, which persists and
  re-loads the checker) or managed in Settings → Spelling (draft,
  persisted on Save). `config:set` / the immediate handler both call
  `invalidate()`, so the next check reflects the change.
- Verdicts are cached per language in `SpellcheckService`, so typing does
  not re-ship the whole field across IPC on every pause; fetched
  suggestions are cached the same way (with a singleflight for a popup
  re-opened before its fetch resolves). Both caches are dropped when the
  language or dictionary list changes.
- The compound splitter accepts some misspelled words ("Hausbaum") and a
  truly misspelled compound part can hide ("Testfhal" survives as a
  typo'd part only if it matches nothing — caught, but "Testfhall" also
  decomposes cleanly). Word-level false negatives are the accepted price;
  the personal-word lists remain the tool for the opposite case.
- Because the underlines are ours and not Chromium's, they are themed with
  the app's tokens and work identically in both editor surfaces — but we
  also own the correctness of the word scanner, which is why it is pure and
  directly tested.
