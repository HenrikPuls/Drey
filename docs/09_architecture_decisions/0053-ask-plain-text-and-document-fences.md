# 0053 — Ask replies as plain text + a `document` fence (JSON envelope retired)

## Status

Accepted (milestone 31; supersedes the JSON-envelope Ask protocol that came with
ADR-0048's chat engine)

## Context

Ask-mode instructed the model to "Respond ONLY with JSON"
(`{"kind":"answer","text":…}` / `{"kind":"edit","document":…}`). The envelope was
unwrapped only after the full reply arrived, which produced two of the beta testers'
complaints:

- **Streaming showed raw JSON.** The partial-answer card appended the wire text
  verbatim, so a compliant model's reply accumulated as `{"kind":"answer","text":"…`
  on screen for the whole generation.
- **Parse failures degraded to raw JSON answer cards.** A truncated reply (output
  cap mid-document), a misspelled `kind`, or a model that returned edit JSON while
  the note chip was deselected all fell through to "show the raw text as the
  answer" — the full document JSON included.

## Decision

1. **Answers are plain prose.** No envelope, so the streaming card is readable
   while it streams and there is nothing to unwrap.
2. **Edits arrive as the complete document inside a fenced block** whose info
   string is `document`, opened with **four backticks**. Per CommonMark, a closing
   fence needs at least as many backticks as the opener, so ordinary ``` fences
   inside the document cannot close the block early.
3. `plugins/assistant/shared/document-fence.ts` extracts the block: line-scan for
   /^(`{3,})\s*document\s*$/, first closer with ≥ N backticks, **longest body
   wins, ties go to the last** (a corrected restatement comes last). Heal
   fallback: a reply that is exactly ONE fenced block of any info string (a
   ```markdown-wrapped document) is accepted; prose or extra blocks outside
   disqualify it.
4. **Degradation ladder (never a raw-JSON card):** fence found + note attached →
   edit outcome (confirm dialog as before). No usable fence → the reply IS the
   answer, verbatim — with plain-text streaming the user just watched the model
   decline or answer, and re-asking is the retry affordance. Answer-only turn
   (note chip off) → any fence is ignored, verbatim answer.
5. **Silent-empty replies are gone at both layers.** Providers return
   `{text:'', toolTrace}` only when the tool loop actually ran (the live-edit
   summary depends on that) and throw `LlmError('bad-reply', …)` otherwise; a
   non-JSON 200 body becomes a clean `bad-reply` with an excerpt instead of a
   leaked `SyntaxError`. The chat engine additionally truncates + throws when a
   non-live turn ends with empty text, so "no response" surfaces as an error line
   with the question kept for a re-send.

## Consequences

- Live edit (ADR-0049) is untouched — the `doc_*` tool loop never used the JSON
  envelope. Chat replay is untouched — persisted turns never contained the
  envelope shape.
- The renderer needs no streaming changes; answers stream readably, edit turns
  stream the document then collapse into the confirm flow.
- Models that ignore the fence format degrade gracefully to an answer the user
  has already read, not an error after the fact.
- Providers without tool support keep failing visibly (unchanged from ADR-0049).
