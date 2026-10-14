# 0072 — Vault context by text search; the embedding retrieval is removed

## Status

Accepted (2026-10-14, milestone 80). Supersedes
[ADR-0055](0055-semantic-vault-retrieval.md) (semantic vault retrieval)
and changes [ADR-0069](0069-agentic-vault-exploration.md) (the retrieval
floor) and [ADR-0071](0071-unified-vault-toolset-and-agent-loop.md) (the
vault toolset loses `vault_retrieve`).

## Context

ADR-0055 gave the assistant's Vault chip a retrieval by meaning: every
note section was embedded with `multilingual-e5-small` (transformers.js,
WASM, in a worker), stored in one JSON vector index per vault, and the
sections closest to the question rode the system prompt. Milestone 68
opened the index to the Search panel (the Semantic toggle) and to MCP;
milestone 77 made that the tool `vault_retrieve`.

In use it did not hold up. The owner's finding, 2026-10-14: the hits did
not fit the question, and a search for a word that stands in a note
("einstein") did not find that note. The code explains it:

- Ranking was cosine similarity alone. A literal occurrence of the
  searched word counted for nothing, and a small embedding model is weak
  exactly on names and single words.
- The score floor (0.3) never filtered: the model's similarities lie
  between about 0.7 and 1.0, so a search always returned its full number
  of hits, fitting or not.
- A section was embedded without its heading and note name, with the
  frontmatter as a section of its own, and cut after 2000 characters.

Each of these could have been repaired. But the largest gain of the
repair plan came from adding text search — the part that needs no
embeddings — and the feature was expensive to keep: a model download on
first use, a slow index build in a single-threaded WASM worker, the ONNX
runtime and transformers.js in the package with stubs for their native
dependencies, unpacked files in the installer, a CI workaround, and about
700 lines of index upkeep. Since milestone 77 a tool-capable model
searches and reads the vault itself (`vault_search`, `vault_read`), with
several wordings if the first finds nothing.

## Decision

**The embedding retrieval is removed.** Gone are: the embedding worker
and the vector index (`plugins/assistant/main/semantic/`), the Settings
page "Assistant retrieval", the Search panel's Semantic toggle, the tool
`vault_retrieve`, the SDK's semantic seam, and the dependencies
`@huggingface/transformers`, `onnxruntime-web`, `onnxruntime-common` and
the two stub packages.

**The Vault chip's context block comes from text search.** With the chip
on, a plain ask carries the note sections that contain words of the
question:

- The question is split into words; stopwords and words under three
  characters are dropped; at most eight are searched.
- Each word is looked up in the section index the tags plugin already
  keeps for the Search panel, through the SDK's section-search seam
  (`ctx.search.sectionSearchProvider()`). The index is in memory, covers
  every section of every vault, matches case-insensitively and inside
  words ("einstein" finds "Einsteins"), and is kept fresh by its owner.
- A section scores the sum of the weights of the words it contains. A
  word found in few sections weighs more than one found in many; a word
  in the heading counts one and a half times. The best four ride the
  question, each cut after 1200 characters.
- Chat notes stay out, for the reason ADR-0055 found: a chat contains the
  question itself.

The assistant owns no index and reads no file for this. Without the tags
plugin there is no context block; the vault tools still work.

**The block is a first selection, not the answer.** The system prompt
says so (unchanged from ADR-0069): a model that can call tools searches
and reads further when the block does not cover the question. A model
without tools gets the block alone.

**The SDK loses a surface under a minor version.** `registerSemanticSearch`,
`api.search.searchSemantic`, `SemanticSearchProvider` and
`SemanticSectionHit` are removed in SDK 1.26. The versioning rule says
minors are additive; this is a stated exception. The seam had one
provider (the assistant) and one caller (the tags plugin), both in this
repository, and a major step would mark every installed plugin
incompatible for a surface none of them could have provided. A plugin
that called `searchSemantic` already had to handle its rejection ("no
provider"); it now has to handle the function's absence.

## Considered and rejected

- **Repairing the retrieval** (heading and note name in the embedded
  text, sections cut into overlapping pieces, a floor that fits the
  model, fusion with text search). It would have fixed the reported case,
  through the text half. The cost stays, and the quality of a model this
  small stays moderate.
- **A larger embedding model.** Better ranking is likely, at a multiple
  of the index build time on the same single-threaded runtime.
- **Keeping it as an option that is off by default.** It already was.
  An option nobody should switch on is upkeep without a user.
- **A full-text index of the assistant's own** (BM25). The section index
  exists, is fresh and matches inside words, which serves German
  compounds and inflection better than whole-token matching.

## Consequences

- No model download, no index build, no background work after enabling
  the Vault chip; nothing to switch on. The installer and the dependency
  tree shrink; the packaging special cases (unpacked ONNX files, the
  stubs, the CI junction step) are gone.
- A question finds a section only through its words. Synonyms and
  paraphrases ("Urlaub" for a note that says "Reise") are not matched by
  the block; that is left to the model's own searches.
- The context block depends on the tags plugin. Its section index does
  not cover the templates folder, so templates never ride as context.
- The block reads saved text: an unsaved change in an open tab is not in
  the index.
- What the removed feature left in the app's data folder
  (`plugins/assistant/semantic-index/`, `models/`) is deleted once when
  the assistant plugin starts. The `semantic.*` keys in the plugin's
  config file are ignored.
- Chat notes written before milestone 80 keep their `drey-context`
  fences; the statuses `disabled` and `empty` with a `floor` are still
  read and shown.
