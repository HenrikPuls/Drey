# Classifier Specification

## Why two prompts instead of one

With the tag-first approach, the user handles topic assignment themselves
most of the time (inline `#tag` + autocomplete). The classifier only needs
to guess the topic when **no** tag is present — the exception, not the
rule. So the common case only needs a very small, fast check instead of a
heavy multi-category classification on every capture. This also lowers
model contention (RTX 4080, 12GB VRAM) in daily use, since Prompt 1 is
minimal and Prompt 2 runs asynchronously in the background, non-blocking.

Note: the prompt text below stays German intentionally — it processes
German note content, and matching the input language is expected to help a
small local model. This is a deliberate choice, see the language note in
`CLAUDE.md`.

---

## Prompt 1 — Task vs. note (runs on EVERY capture)

**Purpose**: only decides whether the entry is formatted as a checkbox task
or a free-text note — no topic logic, no registry context needed.

```
System:
Du analysierst eine kurze, informell geschriebene Notiz auf Deutsch.
Bestimme, ob es eine Aufgabe (etwas, das noch erledigt werden muss) oder
eine reine Beobachtung/Notiz ist. Falls Aufgabe: erkenne, wenn möglich,
Fälligkeit und Dringlichkeit aus der Formulierung.

Heutiges Datum: {current_date}

Antworte AUSSCHLIESSLICH mit diesem JSON-Format, ohne Erklärung:
{"typ": "task" | "notiz", "faelligkeit": "YYYY-MM-DD" | null, "prioritaet": "hoch" | "mittel" | "niedrig" | null}

Notiz: "{input_text}"
```

**Example**
- Input: `"Kiel-Dichtung vor dem Kauf unbedingt prüfen, ist dringend"`
- Output: `{"typ": "task", "faelligkeit": null, "prioritaet": "hoch"}`

**No confidence threshold needed.** Unlike the earlier concept: a wrong
task/note call is low-risk — visible immediately in the document, fixed
with one click on the checkbox/line. No reason to build a confirmation flow for it.

---

## Prompt 2 — Tag suggestion (BATCH ONLY, for entries with no tag)

**Purpose**: doesn't run live during capture, only when the batch review
(inbox) is opened. Needs the **tag registry** as context — derived from the
`description` field of every `type: master` file.

**Implementation note:** this prompt is the built-in **"Autotagging"**
action's template text (`{registry_list}` is substituted with the rendered
registry at call time), so the Actions system and the classifier share one
prompt string — editing the template changes classification. Until the
inbox milestone exists, Autotagging runs on demand against the *active
document's* untagged dated entries instead of a batch queue; the batch/inbox
entry point is added with milestone 7/8.

```
System:
Du bekommst eine Notiz ohne Tag sowie eine Liste bereits existierender
Tags mit Kurzbeschreibung. Schlage 1 bis 3 passende Tags aus der Liste
vor. Falls kein bestehender Tag gut passt, schlage einen NEUEN Tag vor
(ein Wort, kleingeschrieben, keine Umlaute).

Existierende Tags:
{registry_list}

Antworte AUSSCHLIESSLICH mit diesem JSON-Format:
{"vorschlaege": ["tag1", "tag2"], "neuer_tag": "vorschlag" | null}

Notiz: "{input_text}"
```

**Registry format** (generated from the master documents, one line per entry):
```
- sailing (thema): Kriterien, Besichtigungen und Kaufprozess fürs neue Boot
- partner (person): kurze Rollenbezeichnung
- team-neptun (team): Architektur-Team, zuständig für Edge-Plattform
```

**Example**
- Input: `"Zweite Besichtigung ist geplatzt, neuer Kandidat in Kiel"`
- Output: `{"vorschlaege": ["sailing"], "neuer_tag": null}`

**A new tag** lands in the inbox for confirmation, exactly like a new tag
the user typed themselves — never auto-creates a folder on its own.

---

## Technical note: enforcing structured output

⚠️ Plain prompt instructions ("respond with JSON only") are occasionally
ignored by small local models (extra prose around it, Markdown code-block
wrapping, etc.) — this is a known weakness, not a guess. If the LM Studio
server backend (llama.cpp-based) supports `response_format` with JSON
schema/grammar constraining, use that instead of relying on the model's
prompt discipline — saves you parse-error handling in code. Whether the
currently chosen small model (Qwen3-4B / Gemma3-4B) supports this in the
LM Studio setup should be checked before relying on it.

## Scaling note (not an MVP concern, but worth recording)

The registry for Prompt 2 grows with every new tag. For a manageable number
of topics (< 50), putting the full list in the prompt is fine. If the vault
accumulates a very large number of tags over time, the list would need
pre-filtering (e.g. keyword pre-selection instead of the full list) — not
relevant at the current scale, but good to know the registry doesn't scale
indefinitely without hitting context limits eventually.
