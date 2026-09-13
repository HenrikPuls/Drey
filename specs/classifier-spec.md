# Classifier & LLM-Prompt Specification

All prompt texts are **English** (CLAUDE.md language convention). The note
content they process may be any language; the model is only ever asked for
a structured JSON verdict, so matching the input language buys nothing.

Pure message builders and reply parsers live in
`shared/llm/classifier.ts`; `electron/llm/classifier.ts`
(`ClassifierService`) and `electron/llm/action-runner.ts` sequence the
actual LM Studio calls.

---

## Prompt 1 — Task vs. note

**Purpose**: decide whether a short captured entry is formatted as a
checkbox task or a free-text note — nothing else. No topic logic, no
vocabulary context.

**Status**: implemented as `buildTaskMessages` / `parseTaskClassification`
and wrapped by `ClassifierService.classifyEntry`, but **not yet wired**
into the capture flow — capture currently never calls it.

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

**Status**: this is the live prompt behind the drawer's **Autotag**
button. It is the built-in **"Autotag"** Action template
(`AUTOTAG_PROMPT` in `shared/app-config.ts`), run by
`ActionRunner.suggestTags(entryText, vocabulary)`; `{tags}` is substituted
with the current tag vocabulary (one tag per line) at call time. Explicit
invocation only — no on-save, no `⋯` trigger. The reply only **pre-fills**
the drawer's tag field; the user confirms by saving.

```
System:
You are given a short note and the tags already used in this vault.
Suggest 1 to 4 tags for the note: reuse tags from the list where they fit,
and otherwise propose new tags (one word, lowercase, no spaces).

Existing tags:
{tags}

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

## Summarise search results (parked)

A short prose digest of the sections a tag search returned.
`SEARCH_SUMMARY_PROMPT` (`shared/app-config.ts`), the built-in
**"Summarise search results"** Action template, run by
`ActionRunner.summariseSearchResults(query)` over IPC
`tags:summarise-results`. The backend is wired; the search panel's UI
button is currently removed (a plain Markdown **Export** replaced it),
because the digest needs a configured local LLM and a stale
`dist-electron` surfaces the failure as an opaque "error invoking remote".
Re-enabling it is a UI-only change.

```
System:
You are given the sections of a personal note vault that match a search.
Write a short prose digest (3–6 sentences, present tense, no bullet
points, no greeting, no heading) of what they collectively say. Note any
contradictions or open questions last. Return only the digest text.
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

- **`NOTE_SUMMARY_PROMPT`** (`shared/app-config.ts`, built-in "Summarise
  note") — the note assistant panel's automatic summary: 1–3 full
  sentences, no bullets, no heading.
- **`ASK_SYSTEM`** (`electron/llm/action-runner.ts`) — the assistant's Ask
  mode: returns `{"kind":"answer","text":…}` for a question or
  `{"kind":"edit","document":…}` (the whole revised document) for a
  change request.
- **`GENERIC_SYSTEM_SUFFIX`** — appended to a user's own Action template
  prompt when the Action rewrites the document.

---

## Technical note: enforcing structured output

⚠️ Plain prompt instructions ("respond with JSON only") are occasionally
ignored by small local models (extra prose, Markdown code-block wrapping,
etc.) — a known weakness, not a guess. The parsers therefore tolerate a
fenced or prose-prefixed reply (`extractJsonObject` / `parseJsonObject`).
If the backend supports `response_format` with a JSON schema/grammar, use
that instead of relying on the model's prompt discipline — it removes the
parse-error handling. Whether the chosen small model (Qwen3-4B /
Gemma3-4B) supports this in the current setup should be checked before
relying on it.

## Scaling note

Prompt 2 embeds the full tag vocabulary. For tens to low hundreds of tags
this is fine. A vault that accumulates a very large number of tags would
need a pre-filter step (e.g. keyword pre-selection instead of the full
list) before the list threatens the context window — not a current
concern, but the vocabulary does not scale indefinitely.
