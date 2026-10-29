# 0083 — Repository discovery under parent vaults

- Status: accepted (2026-10-29, T-0045; owner idea from the 2026-10-18 round)
- Amends: [ADR-0065](0065-git-vaults-source-control-plugin.md) (the git
  plugin scans below a vault that is no repository itself)
- Relates: [ADR-0082](0082-per-vault-files-seam-and-plugin-managed-repositories.md)
  (plugin-managed vaults are read-only — why discovery must refuse more,
  not less), [ADR-0051](0051-multi-vault-registry.md) (the vault registry
  the one-click registration joins)

## Context

A vault that is only a **parent folder of repositories** — `E:\projects`
with `drey/`, `drey-tickets/`, … inside — showed nothing in Source
control: `git rev-parse` fails at the vault root, and every repository
below had to be registered as its own vault to appear at all. The owner
asked for the app to find them on its own ("kein git repository mehr
explizit auswählen … files erkennt es automatisch").

The hard boundary came first (ADR-0082): a scan must never hand a
structured repository — an unregistered tickets repo — to the panel's
mutation commands. A non-registered tickets repo is claimed by NO plugin
(the tickets `detect()` only probes registered vaults), so vault-granular
managed marks cannot see it.

## Decision

- **Discovery lives in the git plugin** (`plugins/git/main/discover.ts`),
  not base. The scan is fs-only, but "what is a repository" is the
  plugin's domain, and a base scanner registering pseudo-vaults would
  leak hidden ids into every vaultId-keyed surface (tabs, decorations,
  documents) — rejected.
- **A folder is a repository when it carries a `.git` entry** — a
  directory for an ordinary clone, a FILE for a linked worktree (the
  fleet's own worktrees; skipping them would hide half of a parent
  folder like `E:\projects`).
- **Cost bounds are constants**: depth 3 below the vault root, at most 25
  repositories per vault (clipped, logged), dot-directories (`.git`,
  `.tools`, `.drafts`), `node_modules`, reserved `_`-root folders
  (ADR-0080) and the subtrees of other registered vaults are never
  walked; symlinks are not followed.
- **The scan runs only for a vault whose own `locate()` said `none`**,
  and a found repository is never descended into: one vault's
  decorations come only from disjoint repositories, so the
  repo-inside-vault-inside-repo case cannot produce conflicting
  outer/inner decorations by construction (nested-repo surfacing
  rejected — no owner ask).
- **A candidate overlapping another registered vault — ancestor or
  descendant — is dropped**: the other vault reports that repository
  already, and ADR-0082's managed protection stays authoritative for a
  registered tickets vault.
- **Found repositories are surfaced read-only.** Every mutating handler
  of the git plugin refuses a `{ vaultId, subPath }` target as its FIRST
  statement — before any repository is located or git runs — with "This
  repository was found under "\<vault>" and is read-only here. Register
  it as a vault to work with it." Refusing everything the scan found is
  the only airtight honouring of the ADR-0082 boundary (see Context);
  path-granular managed marks would be a follow-up.
- **One click grants work rights**: `ctx.vault.register(path)` (SDK
  1.33) registers the folder exactly like the picker (`VaultManager
  .addVaultAt`) and runs the same composed round the `vaultAdd` IPC
  handler runs — watcher sync + one full refresh; that refresh is what
  makes the panel drop the discovered twin and show the vault's own
  entry. This is also where the tickets plugin starts detecting (marker
  at the new vault's root → ADR-0082 managed → read-only forever).
- **`subPath: ''` addresses the vault's own repository** — every
  existing payload and call site stays valid, no renderer→main version
  skew. Found statuses are parsed repository-relative and re-mapped into
  vault-relative paths (`prefixStatusPaths`), so "Open file", diffs and
  decorations address vault paths; path queries strip the prefix again.
- **Rescans on registry changes and relocate only** (the path-less
  `onChanged` round, `status { relocate: true }` on window focus,
  config changes) — folder-level watcher events fire far too often.
- **Panel keying**: the panel's current repository, drafts and the busy
  bookkeeping key by `vaultId + '::' + subPath` (`''` = the vault id);
  decorations merge all of one vault's entries (own + found) into ONE
  `setFileDecorations` call, because the service replaces the list per
  vault.

## Consequences

- A parent folder vault needs no per-repo registration to be visible:
  branch, status, log, file history, diffs and Files-tree decorations
  arrive for every repository below it (bounded), read-only.
- The panel names the find ("Found by scanning \<vault\> — read-only")
  with the Register button beside it; registration is one click, and the
  tickets case lands in ADR-0082's managed read-only immediately.
- A vault with found repositories never shows the "not a Git repository"
  empty state; one with none found stays as it was.
- Mutations on found repositories (and a path-granular managed registry),
  nested-repo discovery inside a found repo, tickets detection of
  non-registered repositories, watcher-driven rescans and Settings for
  depth/limit stay out of scope — follow-ups if the owner wants them.
