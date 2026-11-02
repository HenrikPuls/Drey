/**
 * The tickets repository's scaffold (M112): one source for both doors —
 * the desk's empty-state initialize (a registered vault) and the engine
 * CLI's `init <dir>` (a repository from nothing, `git init` style). The
 * pipeline text carries the priority vocabulary EXPLICITLY, so the
 * config sits in the `_meta` file beside the phases it governs — visible
 * and editable from day one rather than implied by absence.
 */
import { phaseDirectoryName } from '../contracts/tickets';

export const PIPELINE_PATH = 'tickets/_meta/pipeline.md';
export const REPOS_PATH = 'tickets/_meta/repos.md';
export const PROMPTS_DIR = 'tickets/_meta/prompts';

export const DEFAULT_PIPELINE = `---
priorities: [urgent, high, normal, low]
phases:
  - { id: inbox, title: Inbox, handover: manual }
  - { id: prioritized, title: Prioritized, handover: manual }
  - { id: build, title: Build, wip: 3, claim: true, handover: agent build-default }
  - { id: commit, title: Commit, handover: agent commit-default }
  - { id: done, title: Done, handover: none }
---
The pipeline: ordered phases (first = capture target, last = terminal),
configurable per handover (manual | agent <prompt-ref> | ci | none).
Prioritized is the owner's checkpoint: clarify the task and its
acceptance criteria there; the build step derives file-level detail
itself, against the code it finds. \`priorities:\` names the board's
priority vocabulary in weight order (first = highest; the upper half
jumps the dispatch queue, the middle entry is the default read). See
specs/ticket-schema.md.
Edit freely; the board follows on refresh.
`;

export const DEFAULT_REPOS = `---
repos: {}
---
Work repositories a ticket's \`repo:\`/\`repos:\` fields may name. Example:

  lariscus:
    url: https://dev.azure.com/org/project/_git/lariscus
    branch: main
    policy: Azure DevOps branch policies protect main
`;

/** The scaffold's phase ids in order — also the numbered directories' source. */
export const DEFAULT_PHASE_IDS: readonly string[] = ['inbox', 'prioritized', 'build', 'commit', 'done'];

/** One file the scaffold writes, vault-relative. */
export interface ScaffoldFile {
  readonly path: string;
  readonly text: string;
}

/** The `_meta` configuration files: the pipeline (with the vocabulary) and repos. */
export function initScaffoldFiles(): readonly ScaffoldFile[] {
  return [
    { path: PIPELINE_PATH, text: DEFAULT_PIPELINE },
    { path: REPOS_PATH, text: DEFAULT_REPOS },
  ];
}

/** The numbered phase directories of the scaffold's pipeline (`tickets/10-inbox`, …). */
export function initPhaseDirs(): readonly string[] {
  return DEFAULT_PHASE_IDS.map((id, at) => `tickets/${phaseDirectoryName(at + 1, id)}`);
}
