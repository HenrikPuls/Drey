---
phases:
  - {id: inbox, title: Inbox, handover: manual}
  - {id: prioritized, title: Prioritized, handover: manual}
  - {id: build, title: Build, wip: 3, claim: true, handover: agent build-default, token-budget: 40000000, persona: build-default}
  - {id: commit, title: Commit, handover: agent commit-default, token-budget: 30000000, persona: commit-default}
  - {id: done, title: Done, handover: none}
---
The pipeline: ordered phases (first = capture target, last = terminal),
configurable per handover (manual | agent <prompt-ref> | ci | none).
Workers (M85): a column with `worker:` runs itself — `model:` pins the
model, `workers:` is the pool size, `prompt:` the _meta/prompts/ ref.
Owner 2026-11-01 (req-93): the plan columns are gone — tickets run
prioritized -> build -> commit -> done. Prioritized is the planning
column: clarify the task, its decisions and its acceptance criteria
there (the machine never pulls from it); the build step derives
file-level detail itself, at run time, against the code it finds. A
worker-driven commit column runs the push step (commit-default: branch
onto the integration branch and the remote, then done — owner ruling
2026-10-19). `token-budget:` caps an agent column's daily token spend
(the breaker parks the column for the day once tokensUsed exceeds it;
0 or absent = unlimited). Edit freely; the board follows on refresh.
