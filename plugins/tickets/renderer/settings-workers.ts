import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { WORKER_PROVIDERS, type WorkerProviderId } from '../main/fleet/protocol';
import { el, kv, numberConfig, selectConfig, textConfig } from './settings-dom';

/** One per-runner field: the plugin-config key it writes and how. */
export interface RunnerField {
  readonly id: string;
  readonly label: string;
  readonly key: string;
  readonly kind: 'number' | 'text' | 'select';
  readonly choices?: ReadonlyArray<readonly [string, string]>;
  readonly fallback?: string;
  readonly hint: string;
}

export const RUNNER_LABEL: Readonly<Record<WorkerProviderId, string>> = {
  opencode: 'OpenCode',
  'claude-code': 'Claude Code',
};

const poolField = (provider: WorkerProviderId): RunnerField => ({
  id: `tset-pool-${provider}`,
  label: 'Pool size',
  key: `fleet.pool.${provider}.size`,
  kind: 'number',
  hint: `How many ${RUNNER_LABEL[provider]} runs go at once, across every column. Empty is one.`,
});

const compactField = (provider: WorkerProviderId): RunnerField => ({
  id: `tset-compact-${provider}`,
  label: 'Resume compact threshold — tokens',
  key: `fleet.compactAboveTokens.${provider}`,
  kind: 'number',
  hint: 'Overrides the shared threshold for this runner. Empty uses the shared one.',
});

/**
 * The settings that belong to one CLI runner (req-71) — the keys the main
 * side reads per provider: the pools (req-63), the compact-threshold
 * override (T-0049) and Claude Code's permission flag, which OpenCode
 * never reads (its permissions come from its own config and ask on the
 * card, req-64).
 */
export const RUNNER_FIELDS: Readonly<Record<WorkerProviderId, readonly RunnerField[]>> = {
  opencode: [
    poolField('opencode'),
    {
      id: 'tset-pool-opencode-probe',
      label: 'Pool probe',
      key: 'fleet.pool.opencode.probe',
      kind: 'text',
      hint: 'A llama.cpp server URL: its parallel slots cap the pool. Other servers do not report theirs.',
    },
    compactField('opencode'),
  ],
  'claude-code': [
    poolField('claude-code'),
    {
      id: 'tset-permissions',
      label: 'Dispatched-run permissions',
      key: 'autoPermissionMode',
      kind: 'select',
      choices: [
        ['accept-edits', 'Accept edits (asks before commands)'],
        ['bypass', 'Bypass permissions (unattended)'],
      ],
      fallback: 'accept-edits',
      hint: 'Runs the chain starts on its own have no dialog to ask in.',
    },
    compactField('claude-code'),
  ],
};

/**
 * The Workers section: a runner switch over the selected runner's fields.
 * It opens on `initial` (the default worker's provider); the switch is a
 * view choice only and is not saved.
 */
export function createWorkersSection(
  api: DreyPluginApi,
  initial: WorkerProviderId,
): { readonly root: HTMLElement; select(provider: WorkerProviderId): void } {
  const section = el('section', 'tset-section');
  section.setAttribute('aria-labelledby', 'tset-workers-head');
  const head = el('div', 'tset-section-head');
  const title = el('h3', undefined, 'Workers');
  title.id = 'tset-workers-head';
  const runnerSwitch = el('div', 'tset-runner-switch');
  runnerSwitch.setAttribute('role', 'group');
  runnerSwitch.setAttribute('aria-label', 'Runner');
  head.append(title, runnerSwitch, el('span', 'tset-chip tset-chip-manual', 'Applies on restart'));
  const rows = el('div', 'tset-kv');
  section.append(head, rows);

  const buttons = new Map<WorkerProviderId, HTMLButtonElement>();
  let current: WorkerProviderId | null = null;
  const select = (provider: WorkerProviderId): void => {
    if (provider === current) {
      return;
    }
    current = provider;
    for (const [id, button] of buttons) {
      button.classList.toggle('active', id === provider);
      button.setAttribute('aria-pressed', String(id === provider));
    }
    rows.replaceChildren(...RUNNER_FIELDS[provider].flatMap((field) => kv(field.id, field.label, control(api, field), field.hint)));
  };
  for (const provider of WORKER_PROVIDERS) {
    const button = el('button', undefined, RUNNER_LABEL[provider]);
    button.type = 'button';
    button.addEventListener('click', () => select(provider));
    buttons.set(provider, button);
    runnerSwitch.append(button);
  }
  select(initial);
  return { root: section, select };
}

function control(api: DreyPluginApi, field: RunnerField): HTMLInputElement | HTMLSelectElement {
  switch (field.kind) {
    case 'number':
      return numberConfig(api, field.key);
    case 'text':
      return textConfig(api, field.key);
    case 'select':
      return selectConfig(api, field.key, field.choices ?? [], field.fallback ?? '');
  }
}
