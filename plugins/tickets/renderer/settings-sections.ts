import type { PluginSettingsEntry, PluginSettingsSection } from '../../../shared/plugin-api/renderer';

/**
 * Settings -> Tickets as sections (E13-22, SDK 1.46): the entries listed
 * under the category in Settings, in page order. The page marks the first
 * element of each part `data-settings-section="<id>"`. The first four are
 * the headings board 7g shows (Crew, Default flow, Budget and runners,
 * Mission Control on other devices); the store and the pipeline are the
 * parts the board no longer shows but the page still has.
 */
export const TICKETS_SECTIONS: readonly PluginSettingsSection[] = [
  { id: 'crew', label: 'Crew' },
  { id: 'flow', label: 'Default flow' },
  { id: 'budget', label: 'Budget and runners' },
  { id: 'devices', label: 'Devices' },
  { id: 'store', label: 'Store and Git' },
  { id: 'pipeline', label: 'Pipeline and prompts' },
];

export type TicketsSectionId = (typeof TICKETS_SECTIONS)[number]['id'];

const e = (
  section: TicketsSectionId,
  key: string,
  label: string,
  description: string,
  scope: PluginSettingsEntry['scope'] = 'vault',
): PluginSettingsEntry => ({ key, label, description, section, scope });

/** What the Settings search finds on this page. */
export const TICKETS_ENTRIES: readonly PluginSettingsEntry[] = [
  e('crew', 'team', 'Crew', 'Personas, default crew'),
  e('crew', 'humanName', 'Your name', 'The human persona'),
  e('flow', 'flow', 'Default flow', 'Standard flow, flow editor'),
  e('budget', 'autopilot', 'Autopilot', 'On, paused or off: whether the chain starts new runs'),
  e('budget', 'autopilot.resumeAt', 'Resume paused autopilot at', 'The time a paused autopilot starts again'),
  e('budget', 'budget', 'Daily budget', 'Pause new runs when it is spent'),
  e('budget', 'runners', 'Runners', 'Local, Claude Code, opencode pools'),
  e('budget', 'videos.inGit', 'Walkthrough videos', 'Keep in Git'),
  e('budget', 'videos.maxMb', 'Largest video', 'Size limit per video'),
  e('budget', 'defaultWorker', 'Default worker', 'OpenCode, Claude Code, Kimi Code'),
  e('budget', 'fleet.resumePauseTtlMin', 'Resume pause TTL', 'Warm resume window in minutes'),
  e('budget', 'fleet.contextCapTokens', 'Context cap', 'Tokens before a worker compacts'),
  e('budget', 'gitPath', 'Git executable', 'Only needed when git is not on PATH', 'device'),
  e('devices', 'remote', 'Mission Control on other devices', 'Serve the phone and iPad app, port, Tailscale', 'all-devices'),
  e('devices', 'pairing', 'Pair a device', 'Pairing code and QR, revoke devices', 'all-devices'),
  e('store', 'repository', 'Tickets repository', 'Path of the tickets folder'),
  e('store', 'dk.checkout', 'Ticket store checkout', 'Working copy of the ticket branch', 'device'),
  e('store', 'dk.syncSeconds', 'Sync interval', 'Seconds, remote stores only', 'device'),
  e('store', 'repositories', 'Repositories', 'Launch command, default branch, found repositories'),
  e('pipeline', 'pipeline', 'Pipeline', 'Columns, handover mode, worker per column'),
  e('pipeline', 'prompts', 'Prompts', 'Prompt files of the agent columns'),
];
