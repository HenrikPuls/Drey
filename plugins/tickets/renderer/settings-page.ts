import type { DreyPluginApi, PluginSettingsPageContrib } from '../../../shared/plugin-api/renderer';
import { parseHandover, type BoardSnapshot, type FolderStatus, type PromptListing } from '../shared/tickets';
import { createColumnsSection, effectivePrompt } from './settings-columns';
import { el, iconButton, mutate } from './settings-dom';
import { createPromptsSection } from './settings-prompts';

/**
 * Settings — Tickets (M85, req-46, reworked in req-50 after the Claude
 * Design mockup): the tickets repository's path, the pipeline as one
 * sortable table (settings-columns.ts), the prompt files as a list with
 * the host's Markdown editor (settings-prompts.ts), then the fleet's own
 * settings. Everything shown is read from the tickets vault on every
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
      'The pipeline and its worker pools. A column with a worker runs itself; manual columns are your checkpoints.',
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
        const [snap, folders, listing, configured] = await Promise.all([
          api.backend.invoke('board') as Promise<BoardSnapshot>,
          api.backend.invoke('folders') as Promise<FolderStatus>,
          api.backend.invoke('prompts') as Promise<PromptListing>,
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
      };
      const reload = (): Promise<void> => load().catch(() => undefined);

      const columns = createColumnsSection(api, reload);
      const prompts = createPromptsSection(api, reload);
      body.append(repo, columns.root, prompts.root, fleetSection(api));

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
    ...kv(
      'tset-permissions',
      'Dispatched-run permissions',
      selectConfig(
        api,
        'autoPermissionMode',
        [
          ['accept-edits', 'Accept edits (asks before commands)'],
          ['bypass', 'Bypass permissions (unattended)'],
        ],
        'accept-edits',
      ),
      'Runs the chain starts on its own have no dialog to ask in.',
    ),
    ...kv('tset-git', 'Git executable', textConfig(api, 'gitPath'), 'Empty uses git from PATH.'),
  );
  section.append(head, rows);
  return section;
}

function kv(id: string, label: string, control: HTMLInputElement | HTMLSelectElement, hint: string): HTMLElement[] {
  control.id = id;
  const name = el('label', 'tset-kv-label', label);
  name.htmlFor = id;
  const value = el('div', 'tset-kv-value');
  value.append(control, el('span', 'field-hint', hint));
  return [name, value];
}

function selectConfig(
  api: DreyPluginApi,
  key: string,
  choices: ReadonlyArray<readonly [string, string]>,
  fallback: string,
): HTMLSelectElement {
  const select = el('select');
  for (const [value, label] of choices) {
    select.append(Object.assign(el('option', undefined, label), { value }));
  }
  void api.settings.get<string>(key).then((value) => {
    select.value = value ?? fallback;
  });
  select.addEventListener('change', () => {
    void api.settings.set(key, select.value).catch(() => undefined);
  });
  return select;
}

function textConfig(api: DreyPluginApi, key: string): HTMLInputElement {
  const input = el('input', 'mono-input');
  input.type = 'text';
  input.spellcheck = false;
  void api.settings.get<string>(key).then((value) => {
    input.value = value ?? '';
  });
  input.addEventListener('change', () => {
    void api.settings.set(key, input.value.trim()).catch(() => undefined);
  });
  return input;
}
