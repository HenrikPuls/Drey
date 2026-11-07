# Wave 4 brief — the common block every 4.2–4.8 session gets (the row-specific part is prepended by the integrator)

You are one session of **wave 4, the fidelity wave** of Drey's workflow redesign. The owner's rule: **the screen looks like the board, not approximately.** Your acceptance criterion is a screenshot of the built app that matches the board PNG; the integrator refuses a merge on a visible, unjustified difference.

## Base and branch
- Repository `E:\projects\Drey`. Work in a git worktree **branched off `desktop-integration`** (checked out at `E:\projects\Drey-desktop-integration`; tip ≥ `877d835c`, which holds the 9a frame, milestone 192). **Never `main`**, never push, never touch `origin`. If the app created your worktree from `main`, reset it: `git reset --hard desktop-integration` before the first edit.
- Toolchain: no global Node. `.\dev.ps1` bootstraps `.tools/` + `node_modules/` in a worktree; `. .\env.ps1` per PowerShell session; `.\dev.ps1 -Built` runs the production build (what you screenshot). CLAUDE.md "Toolchain" has the raw commands.
- CLAUDE.md binds: English in every UI string and doc, strings from the i18n catalog (ADR-0091), tokens from `src/styles.css` (no hex), roadmap-first (your row's items are already on the roadmap; anything new gets the next free id with "owner request, outside the list"), changelog entry marked **Not yet manually verified by the owner**, specs upkeep per the table in CLAUDE.md.
- Read first, in this order: `docs/design/work-panel/build-plan.md` §4 (points 1–9) and the wave-4 table; `docs/design/work-panel/fidelity-checklist.md` (all 12 steps, they are your work order); `docs/design/work-panel/boards/README.md` and `boards/notes.md`; the frame rule in `docs/09_architecture_decisions/0019-*.md` ("The frame rule for every panel"); `specs/decisions.md` ("9b is not a target").

## The frame is given (milestone 192)
Panel headers (28 px, fold chevron, hover-only controls), dock strips, tab bar, meta bar, status bar and the tokens are the base's. You draw **inside** the frame. A board element the frame does not give you (a header the plugin would have to draw, a status-bar layout, a dock behaviour) **stops the session**: name board, element, gap, recommendation, and wait — do not approximate.

## The fidelity checklist — your work order (verbatim from fidelity-checklist.md)
0. Before the first edit: open every owned board's PNG **and read its `.dc.html`** (px, hex→token, type, spacing, radii, icons, strings, order); skim the neighbouring boards of the same device. **First report to the integrator, before any edit: a measure sheet per board** (elements with measures, colours as tokens, type, strings) plus the list of what the current build does differently.
1. While building: tokens not hexes, catalog not literals; only your owned files (a deviation in another session's file goes into the deviation list as "belongs to <session>"); an SDK/base gap stops the session.
2. Before reporting done: built app at the board's size (1440×900 desktop / 1194×834 and 834×1194 iPad / 390×844 phone), device scale factor 1, in the state the board shows; screenshot to `test-results/fidelity/<Board>.png`; compare in `boards/compare.html` (side by side, overlay, swipe, diff); deviation list — one row per difference, each **fixed** or justified in one line with one of the permitted reasons: base chrome a plugin cannot draw into, a token in place of a hex, data instead of sample content, an owner decision from notes.md/decisions.md, text rasterization with no CSS difference found. "Looks close", "minor", "later" are not justifications. Repeat until no open row.
3. Report and changelog: a `Fidelity:` block (boards, screenshot paths, window size, the deviation table) in the changelog entry; the report to the integrator carries board PNG + screenshot for every board.

## Done
Commit on your branch (gate green: `npm run test:all`; e2e for your area), changelog + roadmap + specs updated, the Fidelity block written, the report sent with the image pairs. Do not push, do not merge.
