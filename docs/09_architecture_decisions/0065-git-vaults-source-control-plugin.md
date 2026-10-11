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
- Not in this version (stash, merge, amend and commit-and-push followed in
  milestone 67, see the later change below): clone, rebase surfaces (a conflict
  shows as a status; it is resolved in the editor and staged), staging
  parts of a file, amending. Dotfiles (`.gitignore`, `.github/`) stay
  hidden in the tree, as everywhere.
- Drey creates `chats/`, `.drafts/` and daily notes only in the active
  vault. A documentation repository should not be the active vault, or
  those folders land in it.
- The parsers have a unit spec; the process layer is covered by
  `e2e/git.spec.ts` against the real git (skipped where git is not
  installed), not by the unit suite.


## Later change — merge, stash, amend, commit and push, file history (milestone 67)

The first version excluded stash, merge surfaces and amending. The owner
asked for the whole set in one go ("zusammen"), so milestone 67 adds it
inside the same plugin — still the installed git, still no new runtime
dependency. What changed, and the trade-off behind each piece:

**1 · Sync information and the "not pushed" marker.**
`VaultGitState` gains `fetchedAt` (mtime of `FETCH_HEAD`), `stashCount`
and `operation`. The branch button's tooltip names the upstream, how many
commits are not pushed / to pull and when the last fetch ran; the Pull and
Push icons carry the counts in their titles. History rows get `unpushed`
(`rev-list <upstream>..HEAD`; without an upstream every commit counts, but
only when a remote exists — a purely local repository shows no markers).

**2 · Commit and push.**
`commit` takes `push: true`. A second icon (`Ctrl+Shift+Enter`) runs
commit and push as one cancellable command. If the push fails the commit
stays; the error says "The commit was created, but pushing it failed",
because rolling a commit back would be the more surprising behaviour.

**3 · Git history of a file.**
`fileLog` (commits that touched the path, no `--follow`, so a rename ends
the list) and `filePatch` (`git show --format= -p <commit> -- <path>`,
parsed by `parsePatch`). The dialog is reached from the editor context
menu ("Git history…") and the command `git.fileHistory`; the plugin API
has no hook into the tab or Files-panel context menu, and adding one was
not worth a base change. "Restore this version" puts the commit's content
into the editor buffer (one undo step, saved by the user), like the note
history (ADR-0060). It is named **Git history** because "File history…"
is the local note history.

**4 · Merge.**
*Merge a branch…* (the panel's "more" menu or `git.merge`) runs
`git merge --no-edit <branch>`. A merge that stops on conflicts is not an
error: main detects `MERGE_HEAD`, the state carries
`operation: { kind: 'merge', source }`, and the panel shows a banner
("Merging <branch> · n conflicts left") with an abort icon. Each
conflicted file has *Keep mine* / *Keep theirs* (`checkout --ours|--theirs`
then `add`; when that side deleted the file, `rm`), *Mark as resolved*
(stage, as before) and *Open file* for hand editing. The commit icon is
disabled while conflicts remain; with none left, an empty message
completes the merge with git's own (`commit --no-edit`). Branch switching,
stash and amend are disabled during a merge. A conflicting `git pull`
lands in the same state. Rebase and cherry-pick stay out: their "ours" /
"theirs" are reversed and a second in-progress state would double the
surface for little use in a documentation repository.

**5 · Stash.**
*Stash changes* runs `stash push --include-untracked -- .` from the vault
folder, so only the vault's files are put away; *Stashes…* lists them and
applies (`stash pop`, which keeps the stash when applying conflicts —
git's behaviour) or deletes one. Both ask first because files change on
disk; stash, pop and abort are refused while tabs are unsaved, like
checkout and pull.

**6 · Amend.**
*Amend the last commit* switches the commit box to amend mode (the last
message is loaded when the box is empty). It is refused when the commit is
already on the upstream: amending it would need a force-push, which Drey
never issues. With no upstream, or commits not pushed, amend is allowed.
`commit --amend --no-edit` runs when the message is left empty.

**Still out:** clone, rebase / cherry-pick, partial (hunk) staging,
force-push, a graph view, committing to a different author.

**Consequences.**
- The icon set (`src/app/icons/icon.ts`) gains `git-merge`, `archive`,
  `history`, `upload`, `triangle-alert`; the manifest declares the
  `editor` permission (context-menu row).
- Each status round now also reads `stash list` (one more git process)
  and two file stats; `status` stays vault-scoped.
- The process layer is covered by `e2e/git.spec.ts` and by a manual
  check against a scratch repository (merge with a modify/delete
  conflict, ours/theirs, stash push / pop, amend, file patch); the new
  parsers (`parseStashList`, `parsePatch`, `mergeSourceFromMessage`,
  `isCommitId`) have unit specs.
- The status colours are overridden for the Anthrazit theme only (see
  ADR-0057, later change); Drey and the published themes keep the shared
  mid-tones.
