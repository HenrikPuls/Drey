# 14. No timeout on generation; an explicit Cancel and a visible clock instead

## Status

Accepted — replaces the 120 s `/chat/completions` deadline.

## Context

`LmStudioClient.chat` used `AbortSignal.timeout(120_000)`. On real
hardware that turned out to be simply wrong: a local model on a consumer
GPU regularly needs longer than two minutes for a document-sized prompt,
and the request was killed mid-generation — the work was thrown away and
the user was told it had failed, which it had not.

Raising the constant does not fix it, it moves it. There is no correct
value:

- Short enough to be a useful hang detector is short enough to kill
  legitimate work. That is the bug we had.
- Long enough never to kill legitimate work is useless as a hang detector —
  nobody waits ten minutes to find out something is stuck.

The deadline was also answering a question the app has no business
answering. Whether a two-minute wait is worth it depends on what the user
asked for and how urgently they need it, which is information only they
have.

## Decision

**`/chat/completions` carries no timeout at all.** The `GET /models` probe
keeps its 8 s deadline — that one *is* a reachability check, and failing
fast is exactly what it is for.

In its place, two things the user can actually act on:

### An explicit Cancel

`LlmTaskRegistry` (`electron/llm-tasks.ts`) holds an `AbortController` per
in-flight generation, keyed by a task id. `ActionRunner.run` / `.ask` /
`.summarize` all run inside it, and `llm:cancel` aborts one by id.

**The renderer mints the id**, before the call is made
(`LlmTaskService.run`). This is the part worth stating: if the id came back
from the main process the Cancel button could only appear *after* the call
returned — which is precisely when it is no longer needed. Minting it on
the calling side means the button exists for the whole time the request is
outstanding.

A cancelled Action returns a `'noop'` outcome, not an `'error'`, and the
assistant panel reports it on a quiet grey notice line rather than the
accent-coloured error line. Cancelling is a decision, not a fault, and the
UI should not tell the user they broke something by making it.

### A visible clock

While a generation runs, the panel shows `Summarising · thinking 12s` with
the Cancel button next to it, in the same small grey mono as the card
timestamps. When it finishes, the card keeps `took 8s` in that same style.

The clock is not decoration — it is what replaces the timeout. With a
deadline, "is this stuck?" was answered (badly) for the user; without one,
they need to see that something is still happening and how long it has
been. `durationMs` is stored on the card, so "took 1m 04s" survives a
restart like the timestamp does.

The ticker runs at 1 Hz and only while something is in flight; the label
has seconds resolution, so anything faster is wasted work.

## Consequences

- A genuinely hung server now hangs until the user cancels. That is the
  deliberate trade: it is visible (the clock keeps counting) and
  recoverable (one click), where the old behaviour was invisible and
  destroyed real work.
- Every LLM entry point is cancellable, including Actions — one registry,
  one `llm:cancel` channel, one UI pattern.
- `taskId` is optional throughout the IPC signatures, so a call that does
  not need cancelling (an internal classifier call) does not have to invent
  one.
- Not addressed: cancelling does not stop the *server* from generating, it
  only stops us waiting for the answer. Freeing the model would need
  whatever cancellation the server exposes, which the OpenAI-compatible
  dialect does not standardise.
