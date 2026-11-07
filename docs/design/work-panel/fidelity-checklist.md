# Fidelity checklist — every UI session, verbatim in its brief

This is the working form of [build-plan.md §4](build-plan.md). A UI session
(wave 4 and every later session that changes something the user sees) follows
it step by step; the integrator refuses a merge that skipped a step. The
boards are in [boards/](boards/README.md); the owner's rule, 2026-11-06: *the
screen looks like the board, not approximately — if that needs an SDK change,
discuss it first, but it has to really look like that.*

## 0. Before the first edit — read the boards and prove it

1. Open the **PNG** of every board the session owns (the `Boards` column of
   the wave table) **and read its `.dc.html`**: the HTML carries the exact
   measures (px), colours (hex → map to the token), font sizes and weights,
   spacing, radii, icon names, strings and order. Skim the PNGs of the
   neighbouring boards of the same device, so the screen sits in its system.
2. Read `boards/notes.md` (decisions 1–31) and `specs/decisions.md`
   ("9b is not a target") for what is decided already.
3. **First report back to the integrator, before any edit:** a *measure
   sheet* per board — a table of the elements the board shows with their
   measures, colours (as tokens), type and strings, and the list of what the
   current build does differently (open the built app once and look). A
   session that cannot name the board's measures has not read it.

## 1. While building

4. Tokens from `src/styles.css`, never a hex; strings from the i18n catalog,
   never a literal (ADR-0091). Where the board uses a colour the tokens do
   not have, add the token in the frame session's file (4.0) or ask.
5. Change only the files the wave table gives the session. A deviation that
   lives in another session's file goes into the deviation list as
   "belongs to <session>", not into a cross-edit.
6. An SDK or base gap (the board needs a panel header, a status-bar layout,
   a dock behaviour the plugin cannot draw) **stops the session**: name the
   board, the element, the gap and a recommendation, and wait for the owner.
   Do not approximate around it — an approximation is exactly what the rule
   forbids.

## 2. Before reporting done — the comparison

7. Start the built app (`.\dev.ps1 -Built`; Mission Control: the fake-desk
   e2e fixture or the engine's served page), set the window to the board's
   size (1440×900 / 1194×834 / 834×1194 / 390×844; Electron:
   `win.setContentSize`, browsers: `resize_window`), and put the app in the
   **state the board shows**: same view, same tab, same ticket, same panels
   open or closed, same hover/popover if the board shows one. Sample data
   that the board shows (ticket ids, names, numbers) may differ; layout may
   not.
8. Screenshot at 1:1 (no DPI scaling: `--force-device-scale-factor=1` or a
   `deviceScaleFactor: 1` fixture). Save it beside the board's PNG name
   under `test-results/fidelity/<Board>.png` (gitignored) and also attach it
   to the report.
9. Open `boards/compare.html`, load the board PNG and the screenshot, and go
   through **side by side, overlay and swipe**. Write the **deviation
   list**: one row per difference — region, what the board shows, what the
   build shows, and either *fixed* or *justified in one line*. Permitted
   justifications are only: base chrome a plugin cannot draw into (names the
   frame session), a token in place of a hex, data instead of sample
   content, an owner decision from `notes.md` / `decisions.md`. "Looks
   close", "minor" and "later" are not justifications.
10. Fix every row that is not justified, re-shoot, repeat until the list has
    no open row.

## 3. The report and the changelog entry

11. The changelog entry gets a `Fidelity:` block: the boards, the
    screenshot paths, the deviation table (fixed rows may be summarised in
    one line, justified rows stay one per line), and the window size used.
12. The report to the integrator carries the board PNG and the screenshot
    (or the compare.html capture) for every board; the integrator opens the
    pair and refuses the merge on a visible, unjustified difference.

## What the integrator checks (4.7 and every merge)

- The measure sheet of step 3 exists in the session's first report.
- Every owned board has a screenshot at the board's size and a deviation
  table with no open row.
- The screenshot was taken from the **built** app on the branch tip, not
  from the dev server of an older build (`dist-electron` timestamps).
- No hex, no literal string in the diff (`npm run lint` + the i18n guard).
