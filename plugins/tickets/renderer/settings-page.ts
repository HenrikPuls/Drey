import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import { parseHandover, type BoardSnapshot, type FolderStatus, type PromptListing, type ReposListing } from '../shared/tickets';
import { createColumnsSection, effectivePrompt } from './settings-columns';
import { parseWorkerValue } from '../../../packages/tickets-engine/src/fleet/assignment';
import { el, iconButton, kv, mutate, numberConfig, selectConfig, textConfig } from './settings-dom';
import { createPromptsSection } from './settings-prompts';
import { createRemoteSection } from './settings-remote';
import { createReposSection } from './settings-repos';
import { createWorkersSection } from './settings-workers';

/**
 * Settings — Tickets (M85, req-46, reworked in req-50 after the Claude
 * Design mockup): the tickets repository's path, the pipeline as one
 * sortable table (settings-columns.ts), the prompt files as a list with
 * the host's Markdown editor (settings-prompts.ts), then the fleet's own
 * settings — the shared ones, then each CLI runner's behind a switch
 * (settings-workers.ts, req-71). Everything shown is read from the tickets vault on every
 * refresh — `pipeline.md`, the phase folders, `_meta/prompts/` — and the
 * page follows the board's change events, so it never shows a copy that
 * drifted from disk.
 */
export function createTicketsSettingsPage(api: DreyPluginApi): PluginSettingsPageContrib {
  return {
    id: 'tickets',
    label: 'Tickets',
    hint: 'Board & fleet',
    description:
      'The pipeline and its workers. A column with a worker runs itself; manual columns are your checkpoints. Each CLI runner has its own pool and settings.',
    mount: (body) => {
      body.classList.add('tset');

      const repo = el('div', 'tset-repo');
      const repoPath = el('span', 'tset-repo-path');
      const openRepo = iconButton(api, 'folder', 'Open the tickets folder');
      openRepo.addEventListener('click', () => void mutate(api, 'openFolder', { which: 'tickets' }));
      repo.append(el('span', 'tset-muted', 'Tickets repository'), repoPath, openRepo);

      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const load = async (): Promise<void> => {
        const [snap, folders, listing, reposListing, configured] = await Promise.all([
          api.backend.invoke('board') as Promise<BoardSnapshot>,
          api.backend.invoke('folders') as Promise<FolderStatus>,
          api.backend.invoke('prompts') as Promise<PromptListing>,
          api.backend.invoke('reposListing') as Promise<ReposListing>,
          api.settings.get<string>('defaultWorker'),
        ]);
        if (disposed) {
          return;
        }
        repoPath.textContent = folders.root ?? 'No tickets vault detected';
        openRepo.disabled = folders.root === null;
        const usage = new Map<string, string[]>();
        for (const phase of snap.pipeline) {
          const ref = parseHandover(phase.handover).mode === 'agent' ? effectivePrompt(phase) : null;
          if (ref !== null) {
            usage.set(ref, [...(usage.get(ref) ?? []), phase.title]);
          }
        }
        columns.update({
          pipeline: snap.pipeline,
          folders,
          promptRefs: listing.entries.map((e) => e.ref),
          defaultWorker: (configured ?? '') || 'opencode',
        });
        prompts.update(listing, usage);
        repos.update(reposListing);
        if (!workersOpened) {
          workersOpened = true;
          workers.select(parseWorkerValue((configured ?? '') || 'opencode')?.provider ?? 'opencode');
        }
      };
      const reload = (): Promise<void> => load().catch(() => undefined);

      const columns = createColumnsSection(api, reload);
      const prompts = createPromptsSection(api, reload);
      const repos = createReposSection(api, reload);
      // Opens on the default worker's runner once the first load knows it.
      const workers = createWorkersSection(api, 'opencode');
      let workersOpened = false;
      const remote = createRemoteSection(api);
      body.append(repo, columns.root, repos.root, prompts.root, fleetSection(api), workers.root, remote.root);

      // The board's change events cover every write here and the runner's.
      const off = api.backend.on('board-changed', () => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        timer = setTimeout(() => {
          timer = null;
          void reload();
        }, 250);
      });
      void reload();
      return () => {
        disposed = true;
        off();
        if (timer !== null) {
          clearTimeout(timer);
        }
        prompts.dispose();
        remote.dispose();
      };
    },
  };
}

// --- the fleet's own settings (plugin config; applied on restart) ----------

function fleetSection(api: DreyPluginApi): HTMLElement {
  const section = el('section', 'tset-section');
  section.setAttribute('aria-labelledby', 'tset-fleet-head');
  const head = el('div', 'tset-section-head');
  const title = el('h3', undefined, 'Fleet');
  title.id = 'tset-fleet-head';
  head.append(title, el('span', 'tset-chip tset-chip-manual', 'Applies on restart'));
  const rows = el('div', 'tset-kv');
  rows.append(
    ...kv(
      'tset-default-worker',
      'Default worker',
      selectConfig(api, 'defaultWorker', [
        ['opencode', 'OpenCode'],
        ['claude-code', 'Claude Code'],
      ], 'opencode'),
      'For a run no ticket, column or repository assigns a worker to.',
    ),
  );
  // Rarely worth touching: folded away, every empty field showing its default.
  const advanced = el('details', 'tset-advanced');
  advanced.append(el('summary', undefined, 'Advanced'));
  const advancedRows = el('div', 'tset-kv');
  advancedRows.append(
    ...kv('tset-git', 'Git executable', textConfig(api, 'gitPath'), 'Only needed when git is not on PATH.'),
    ...kv(
      'tset-handover-ttl',
      'Resume pause TTL — minutes',
      numberConfig(api, 'fleet.resumePauseTtlMin'),
      'A pause within this window counts as warm: the previous session resumes and re-pays its transcript as cache reads.',
    ),
    ...kv(
      'tset-context-cap',
      'Context cap — tokens',
      numberConfig(api, 'fleet.contextCapTokens'),
      'OpenCode compacts a running worker\'s context once it reaches this size instead of the model\'s full window. 0 = the model\'s own window.',
    ),
  );
  advanced.append(advancedRows);
  section.append(head, rows, advanced);
  return section;
}
