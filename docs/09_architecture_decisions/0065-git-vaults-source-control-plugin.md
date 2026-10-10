# 64. A vault can be a Git repository: a source-control plugin over the installed git

## Status

Accepted (milestone 65, req-40). Builds on ADR-0044 (the plugin system),
ADR-0051 (several vaults) and ADR-0045 (the external-change round).
Changes the save-time frontmatter rule of ADR-0007.

## Context

The wish: keep documentation that lives in a Git repository — an
architecture documentation built with mkdocs, checked out next to the
code — in Drey as a vault, and work with it there: see which files are
changed, new or deleted, commit, push and pull, switch branches.

Three things stood in the way. The Files panel showed nothing about a
file but its name. There was no surface for Git at all. And Drey's own
housekeeping fought the use case: every save of a note with a
frontmatter fence set `updated:` and added a missing `created:`, which in
somebody else's Markdown is a diff on every page touched.

Questions with real alternatives: how Git is reached, where the feature
lives, how the Files panel learns a file's status, and what a save does
to frontmatter.

## Decision

**1 · The installed `git`, run as a process.**
`plugins/git/main/git-runner.ts` runs `git` with `execFile` — no shell,
so a file or branch name is never read as shell syntax, and paths go in
as literal pathspecs. Push and pull then use whatever the user already
has: the credential manager, SSH keys and agent, proxies, `.gitconfig`,
hooks, LFS. The environment switches the terminal prompt off; a
credential helper answers or the command fails with git's own message.
Commands are queued per repository, network commands have no timeout
but can be cancelled (the ADR-0014 stance; the process tree is killed).
When git is missing the panel says so, and Settings → Git takes a path.

**2 · A plugin, not base.**
`plugins/git/` holds everything Git: the runner, the parsers for git's
output (`shared/status.ts`, pure), the command handlers, and the "Source
control" dock panel. It can be switched off like any plugin. A vault is
the repository root or a folder inside it (`docs/`); status, "stage all"
and the lists are limited to the vault folder. A commit is git's commit
and takes whatever is staged — the panel says when staged files lie
outside the vault.

**3 · The Files panel learns decorations, not Git (SDK 1.17).**
Three additive seams:

- `api.ui.setFileDecorations(vaultId, list)` — a plugin hands in a badge
  and a tone per path. The base's `FileDecorationService` merges the
  sets and gives each folder the strongest tone among its descendants.
  The Files panel colours the name and shows the badge.
- `api.ui.showDiff(request)` — the shared `DiffView` as a read-only
  dialog, so a plugin can show "before / after" without carrying a diff.
- `ctx.vault.announceChanges(…)` — a plugin that rewrote the working tree
  (checkout, pull, discard) starts the same round an external change
  runs: the tree reloads, the indexes follow, clean open tabs reload.

**4 · Deleted files appear in the panel, not in the tree.**
The tree shows what is on disk. A deleted file has no row; its folders
carry the tone, and the file itself is listed under "Changes".

**5 · Nothing is lost without a question.**
A commit while tabs of the vault are unsaved asks (commit anyway / save
all and commit). Switching the branch and pulling are refused while the
vault has unsaved tabs. Discarding asks, and an untracked file goes to
the recycle bin over the app's own delete path, not `git clean`.

**6 · A save never adds frontmatter.**
`touchUpdated` (`shared/frontmatter.ts`) sets `updated:` only where the
note already has that key, and adds nothing — no `updated:`, no
`created:`. This holds in every vault. New notes get their dates from
the template that creates them (daily notes, chat notes), as before.

## Considered and rejected

- **isomorphic-git** (pure JavaScript, no installed git needed). No SSH;
  credentials would have to be collected and stored by Drey, in plain
  text like the API keys; no hooks, LFS or `.gitconfig`; slow on large
  repositories. The target user of this feature has git installed.
- **A native binding (nodegit / libgit2).** A native module, which the
  project has avoided throughout (ADR-0055), for less compatibility with
  the user's setup than the CLI gives.
- **Git status inside the Files panel.** The base would know Git, and a
  disabled plugin would leave dead code in the tree. A decoration seam
  is smaller and serves other sources later (sync state, lint).
- **Ghost rows for deleted files in the tree.** Rows without a file need
  exceptions in opening, renaming, dragging, keyboard navigation and
  multi-selection, for information the panel already shows.
- **A per-vault "manage frontmatter dates" switch.** One more setting to
  explain, and the wrong default somewhere. "Update what is there, add
  nothing" needs no switch and is right for foreign and own notes alike.

## Consequences

- A note saved before this change with a fence but no `updated:` no
  longer gains one. Notes that have the key behave as before.
- git must be installed for the feature; without it the rest of the app
  is unaffected.
- The status is recomputed after saves, vault change rounds, the
  plugin's own commands and when the window regains focus. With the
  vault watcher off, a change made outside the app shows up on the next
  of those — the same staleness the tree itself has (ADR-0018).
- An SSH key with a passphrase and no agent cannot prompt and fails;
  the message is git's.
- Not in this version: clone, stash, merge / rebase surfaces (a conflict
  shows as a status; it is resolved in the editor and staged), staging
  parts of a file, amending. Dotfiles (`.gitignore`, `.github/`) stay
  hidden in the tree, as everywhere.
- Drey creates `chats/`, `.drafts/` and daily notes only in the active
  vault. A documentation repository should not be the active vault, or
  those folders land in it.
- The parsers have a unit spec; the process layer is covered by
  `e2e/git.spec.ts` against the real git (skipped where git is not
  installed), not by the unit suite.
