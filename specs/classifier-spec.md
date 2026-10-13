# Classifier & LLM-Prompt Specification

All prompt texts are **English** (CLAUDE.md language convention). The note
content they process may be any language; the model is only ever asked for
a structured JSON verdict, so matching the input language buys nothing.

Pure message builders and reply parsers live in
`shared/llm/classifier.ts`. The calls themselves are sequenced by
`electron/llm/tag-suggest.ts` (`TagSuggester`, Autotag) and, for the
assistant, by `plugins/assistant/main/` (`chat-engine.ts`,
`action-engine.ts`, prompts in `ask-prompts.ts`) over the provider
abstraction in `electron/llm/` (ADR-0047).

---

## Prompt 1 — Task vs. note

**Purpose**: decide whether a short captured entry is formatted as a
checkbox task or a free-text note — nothing else. No topic logic, no
vocabulary context.

**Status**: only the pure halves exist — `buildTaskMessages` /
`parseTaskClassification` in `shared/llm/classifier.ts`. No service wraps
them any more (`ClassifierService.classifyEntry` is gone) and nothing
calls them: capture never classifies. Treat as dead code until a
capture flow needs it.

```
System:
You classify a short, informally written note. Decide whether it is a task
(something still to be done) or a plain observation/note. If it is a task,
read a due date and an urgency from the wording where possible.

Today's date: {current_date}

Respond ONLY with this JSON, no prose:
{"type": "task" | "note", "due": "YYYY-MM-DD" | null, "priority": "high" | "medium" | "low" | null}
```

The note text goes in as the user message. `{current_date}` is
substituted with today's date at call time.

**Example**

- Input: `"Kiel-Dichtung vor dem Kauf unbedingt prüfen, ist dringend"`
- Output: `{"type": "task", "due": null, "priority": "high"}`

**No confidence threshold needed.** A wrong task/note call is low-risk —
visible immediately in the document, fixed with one click on the
checkbox/line. No confirmation flow for it.

---

## Prompt 2 — Tag suggestion from the vault vocabulary

**Purpose**: suggest tags for an untagged entry, reusing tags the vault
already uses where they fit and otherwise proposing new ones. There is no
tag registry with descriptions any more, and **no folder proposal** — a
tag is just a label.

**Status**: this is the live prompt behind the editor's `⋯` **Suggest
tags** row (req-36, milestone 45 — the re-homed Autotag; the entry drawer
that carried the old button is gone since ADR-0057). It is the built-in
**"Autotag"** Action template (`AUTOTAG_PROMPT` in `shared/config/schema.ts`),
run by `TagSuggester.suggest(entryText, vocabulary)` over the
`tags:suggest` channel; `{{AVAILABLE_TAGS}}` is substituted with the
current tag vocabulary (one tag per line) at call time — see "The
vocabulary placeholder" below. The row sends the
heading-delimited section under the caret (`shared/note-sections.ts` —
the same unit the tag search reports on) and **applies the reply
directly**: the suggested tags are appended to the section's last prose
line, deduplicated against the tags it already carries, one undo step,
saved immediately. Explicit invocation only — no on-save trigger.

```
System:
You are given a short note and the tags already used in this vault.
Suggest 1 to 4 tags for the note: reuse tags from the list where they fit,
and otherwise propose new tags (one word, lowercase, no spaces).

Existing tags:
{{AVAILABLE_TAGS}}

Respond ONLY with JSON, no prose: {"tags": ["tag1", "tag2"]}
```

Parsed by `parseSuggestedTags` — normalised (lower-case, umlauts
transliterated, one hyphenated word; a `/` is kept so a nested suggestion
like `project/frontend` survives), de-duplicated, capped at four.

**Example**

- Vocabulary: `sailing`, `arbeit`, `rollout-sync`, …
- Input: `"Zweite Besichtigung ist geplatzt, neuer Kandidat in Kiel"`
- Output: `{"tags": ["sailing"]}`

### Richer variant (implemented, not wired)

`shared/llm/classifier.ts` also carries `buildTagSuggestionMessages` /
`parseTagSuggestion`, which take a described list via a `{registry_list}`
placeholder and return
`{"suggestions": ["tag1", "tag2"], "new_tag": "proposal" | null}`. Kept
for a possible future batch / described-vocabulary flow; nothing calls it
today.

---

## Summarise search results (shipped, milestone 37)

A comprehensive topic digest of the sections a tag search returned.
`SEARCH_SUMMARY_PROMPT` (`shared/config/schema.ts`) ships as the built-in
**"Summarise search results"** Action template and stays **editable** in
Settings → Actions — the tags plugin's `summarise` backend loads the
stored (possibly user-edited) text from app config and only falls back to
the constant. The Search panel's **Summarize** button (visible when an
LLM is configured) sends the hit sections — whole sections up to a
~60 000-character budget, cut at a section boundary and stated — through
`ctx.llm.chat`; the digest streams into an unsaved `search-summary.md`
scratch tab (cancel via the panel's Stop button, ADR-0014). Details:
runtime view §6.43 and [ADR-0017](../docs/09_architecture_decisions/0017-tags-as-labels-and-section-index.md).

```
System:
You are given the sections of a personal note vault that matched a
search, each introduced by its path, line and heading. Write a
comprehensive digest of what they collectively say about the search
topic, in the same language as the notes. Group the material into short
thematic blocks, each opening with a bold lead-in; within a block state
the key facts, decisions and arguments concretely (names, dates,
numbers) instead of paraphrasing vaguely. Never invent content that is
not in the sections. End with a paragraph "Open questions /
contradictions" listing what the sections leave unresolved or state
inconsistently — omit it when there is none. Cite sources by their path
in parentheses where that helps navigation. No greeting, no top-level
heading, no closing pleasantries. Return only the digest text.
```

---

## Prompt 3 — OCR: Recognize text (plugins/ocr, ADR-0050)

The `ocr` plugin's context-menu row transcribes an image (embedded in a
note, or opened as an image tab) through the connected vision-capable
LLM. **The prompt lives in the plugin**
(`plugins/ocr/shared/ocr-prompt.ts`), not in `shared/app-config.ts` —
unlike the Autotag prompt it has no user-editable template (v1). The
image rides `MainChatOptions.attachments` as a base64 `ChatAttachment`
on the last user message; the call runs in the plugin's main entry
(`ctx.llm.chat`), gated on the `imageAttachments` capability.

```
System:
You are an OCR assistant. Transcribe ALL text visible in the image.
Rules:
- Transcribe verbatim. Do not translate, correct, summarize, or comment.
- Preserve the original line breaks, list markers, and simple structure.
- Output plain Markdown only. Do not wrap the transcription in a code fence.
- Mark words you cannot read as [illegible]. If the image shows no text, output [no text].

User:
Transcribe all text visible in this image.   (image via attachments)
```

The reply is plain text (no JSON protocol) and goes through a tolerant
cleanup: one outer code fence is stripped when it wraps the whole reply
(`stripOuterFence`, same stance as `parseJsonObject`). Embedded results
are spliced below the image line through the ADR-0011 confirmation
rewrite; image-tab results open as a scratch tab.

---

## Other LLM prompts (for completeness)

- **`ASK_SYSTEM`** (`plugins/assistant/main/ask-prompts.ts`) — the
  assistant's Ask mode on a document: returns `{"kind":"answer","text":…}`
  for a question or `{"kind":"edit","document":…}` (the whole revised
  document) for a change request. `ASK_ANSWER_SYSTEM` is the plain-answer
  variant over the vault context.
- **The ask user message** (`buildAskUserMessage`, same file) — blocks
  in this order, separated by a blank line: `INSTRUCTION / QUESTION:`,
  then — only when the question was asked from the button at a selection
  (milestone 74) — `SELECTED SECTION (the question is about this part of
  the document):` with the selected text verbatim, then
  `DOCUMENT (<path>):` when the note chip is on, then one
  `FILE (<path>):` per attached file. The system prompt does not change
  for a selection; the reply protocol (answer or whole-document edit) is
  the same.
- **Ask notes** (same file) — appended to the system prompt depending on
  what rides the ask: `ASK_TOOLS_NOTE` / `ASK_SCOPED_TOOLS_NOTE` (vault
  tools, ADR-0021/0063), `ASK_EXPLORE_NOTE` (the explore tools
  `vault_overview` / `vault_find` / `vault_section`, ADR-0069),
  `ASK_WEB_NOTE`, `ASK_TASKS_NOTE` (restricted to task questions),
  `ASK_TEMPLATES_NOTE`, `ASK_LINKS_NOTE`, the date note and the vault
  scope note that binds "the vault" to the Vault chip's selection.
- **`TITLE_SYSTEM`** — names a chat note from its first exchange.
- **`GENERIC_SYSTEM_SUFFIX`** (`plugins/assistant/main/action-engine.ts`) —
  appended to a user's own Action template prompt when the Action rewrites
  the document. The Action context carries the current selection
  (`SELECTED SECTION`) next to the whole document.
- The former built-in "Summarise note" (`builtin:note-summary`) is
  retired (`RETIRED_BUILTIN_TEMPLATE_IDS` in `shared/config/normalize.ts`).

---

## The vocabulary placeholder — `{{AVAILABLE_TAGS}}`

One token, shared by every prompt that embeds the vault's tag
vocabulary: `substituteVocabulary` (`shared/llm/prompt-substitution.ts`)
replaces `{{AVAILABLE_TAGS}}` with the tag list, one tag per line.

- The reserved `task` is filtered out — it is never offered as a tag.
- An empty vocabulary substitutes `(none yet)`.
- Autotag's original `{tags}` spelling is still substituted, so a stored,
  user-edited Autotag prompt keeps working. A stored `builtin:autotag`
  prompt that still equals the old default (`LEGACY_AUTOTAG_PROMPT`) is
  refreshed to the current one by `normalizeAppConfig`.
- It works in **every** Action template, the user's own included: the
  assistant's `ActionEngine` substitutes it into the system prompt of any
  action it runs. The vocabulary reaches the plugin through
  `ctx.search.sectionSearchProvider()` (SDK 1.21); with the tags plugin
  disabled the list is empty.

There is **no `{{NOTE}}` placeholder** (the draft had one): the note
rides the user message, as for every Action — and the selection, when
there is one, as `SELECTED SECTION` above `WHOLE DOCUMENT`.

---

## Lossless Markdown formatting template (shipped, milestone 73)

The built-in **"Structure note (lossless)"** Action template
(`LOSSLESS_FORMAT_PROMPT` in `shared/config/schema.ts`,
`builtin:lossless-format`): turns a raw note into structured Markdown
**without** adding or interpreting anything, and tags it from the
existing vocabulary only. Editable in Settings → Actions like the other
built-ins, not deletable. `resultKind: 'document'` — the reply is free
Markdown, not JSON, so there is no parser: it goes through the ADR-0011
whole-document confirmation (aligned split diff), and a reply equal to
the note is a no-op. `GENERIC_SYSTEM_SUFFIX` is appended as for every
document-rewriting Action.

A fresh config ships one **manual** trigger for it
(`trigger:lossless-format`, confirm on), so it is a row in the editor's
`⋯` menu out of the box. An existing config's trigger list is the user's
own and is not touched — there the trigger is added once in Settings →
Actions.

```
System:
Transform the note into structured Markdown.

This is a lossless formatting task, not a summarization task.

STRICT REQUIREMENTS:

- Preserve all factual information from the source.
- Never add information that is not explicitly contained in the source.
- Never infer missing context.
- Never answer questions found in the source.
- Never interpret the author's intentions.
- Never create decisions, conclusions, tasks, deadlines, or responsibilities unless explicitly stated.
- Keep the original language.
- Correct only obvious spelling or grammar errors.
- Retain uncertainty, open questions, and incomplete information as such.
- Group related statements when this can be done without interpretation.
- Use headings and bullet points only where they improve readability.
- Preserve chronological relationships.

TAGGING:

The valid tags are listed in AVAILABLE_TAGS.

- Only use tags from AVAILABLE_TAGS; never create new tags.
- Add a tag only when the note provides direct evidence that it applies.
- If multiple tags could apply and the choice is ambiguous, add none.
- Add person tags only when that person is explicitly mentioned; match names against AVAILABLE_TAGS and do not infer a person's identity from context alone.
- Avoid redundant and overly broad tags.

Output only the final Markdown.

AVAILABLE_TAGS:
{{AVAILABLE_TAGS}}
```

The note goes in as the user message.

**Limits.** The prompt only *instructs* the model to stay inside the
vocabulary — nothing strips an invented tag from the reply; the
confirmation diff is where the user catches it. The full vocabulary in
`AVAILABLE_TAGS` has the same size limit as Autotag (see "Scaling note").

---

## Technical note: enforcing structured output

⚠️ Plain prompt instructions ("respond with JSON only") are occasionally
ignored by small local models (extra prose, Markdown code-block wrapping,
etc.) — a known weakness, not a guess. The parsers therefore tolerate a
fenced or prose-prefixed reply (`extractJsonObject` / `parseJsonObject`).
If the backend supports `response_format` with a JSON schema/grammar, use
that instead of relying on the model's prompt discipline — it removes the
parse-error handling. (As of 2026-10-12 nothing in the code sets
`response_format`.) Whether the chosen small model (Qwen3-4B /
Gemma3-4B) supports this in the current setup should be checked before
relying on it.

## Scaling note

Prompt 2 and the lossless template above embed the full tag
vocabulary. For tens to low hundreds of tags this is fine. A vault that accumulates a very large number of tags would
need a pre-filter step (roadmap "Next": tags at scale) (e.g. keyword pre-selection instead of the full
list) before the list threatens the context window — not a current
concern, but the vocabulary does not scale indefinitely.
