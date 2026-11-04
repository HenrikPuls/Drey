# Ticket triage for the dricket migration

Owner word 2026-11-04: migrate the tickets that are still valid, mark the
rest obsolete and archive them. State of the legacy repo `drey-tickets`
when this was written: 25 tickets in `10-inbox`, 2 in `20-prioritized`, none in
build / commit / done, 64 already in `archive/` (not migrated, OD-6).

Method: each ticket's description read against `specs/roadmap.md` and
`specs/changelog.md`. "Verified" means a changelog or roadmap line names the
shipped work; nothing here was checked in a running app.

## Obsolete -> archive (2)

| Ticket | Reason | Evidence |
|---|---|---|
| T-0079 Plan to approve, one card per part | Shipped as E10-4 | changelog milestone 126; roadmap keeps only the follow-up E10-4b |
| T-0087 Re-integrate T-0043 settings round 2 | Superseded: the column CRUD lives in the flow editor (E10-5, milestone 128), the settings page in E13-12 (milestone 146); the stale branch `t/T-0043` is not needed | changelog 128 / 146. Not compared line by line with the old branch |

## Close at the fleet cut-over, do not migrate (3)

T-0088, T-0089, T-0090 describe the old chain daemon and circuit breaker in
`packages/tickets-engine`. They stay valid while that runner is the live one
and become obsolete when the fleet is replaced by `dk` (E14-6). They are
archived then, with the reason "runner replaced by dricket".

## Migrate (22)

Backlog and follow-up tickets that name work no shipped milestone covers:

- Follow-ups of shipped milestones: T-0023, T-0024, T-0028, T-0030, T-0032,
  T-0033, T-0035, T-0037, T-0039
- Roadmap backlog: T-0010, T-0013, T-0015, T-0016, T-0017 (its blocker
  T-0049 is archived, so it is unblocked), T-0018 (owner decision on
  section numbers still applies)
- Ideas: T-0066 (priority low), T-0067 (low), T-0068 (low), T-0069, T-0070,
  T-0083
- T-0091 Review card (prioritized): partly overtaken by the Review tab
  (E13-7) and the Markdown surface (E12-6), but it targets the Drey panel's
  Ready card; migrate with a note to re-check the four points first.

## Order of work

1. This list is the contract. The two obsolete tickets are archived in the
   legacy repo now (reason line in the ticket, git move to `archive/`).
2. The 22 migrate after the write path exists (E14-4: `dk put` / import
   with fixed IDs, R-01..R-04, R-10); IDs map `T-0010` <-> `t-10`.
3. The three runner tickets close at E14-6.
