import type { PluginSettingsEntry, PluginSettingsSection } from '../../../shared/plugin-api/renderer';

/**
 * Settings -> Tickets as sections (E13-22, SDK 1.46): the entries listed
 * under the category in Settings, in page order. The page marks the first
 * element of each part `data-settings-section="<id>"`. The first three are
 * the headings board 7g shows (Crew and Default flow, Budget and runners,
 * Mission Control on other devices); the store and the pipeline are the
 * parts the board no longer shows but the page still has.
 */
export const TICKETS_SECTIONS: readonly PluginSettingsSection[] = [
  { id: 'team-flow', label: 'Crew and flow' },
  { id: 'budget', label: 'Budget and runners' },
  { id: 'devices', label: 'Devices' },
  { id: 'store', label: 'Store and Git' },
  { id: 'pipeline', label: 'Pipeline and prompts' },
];

export type TicketsSectionId = (typeof TICKETS_SECTIONS)[number]['id'];

/** What the Settings search finds on this page. */
export const TICKETS_ENTRIES: readonly PluginSettingsEntry[] = [
  { key: 'team', label: 'Crew', description: 'Personas, default crew', section: 'team-flow' },
  { key: 'humanName', label: 'Your name', description: 'The human persona', section: 'team-flow' },
  { key: 'flow', label: 'Default flow', description: 'Standard flow, flow editor', section: 'team-flow' },
  { key: 'budget', label: 'Daily budget', description: 'Pause new runs when it is spent', section: 'budget' },
  { key: 'runners', label: 'Runners', description: 'Local, Claude Code, opencode pools', section: 'budget' },
  { key: 'videos.inGit', label: 'Walkthrough videos', description: 'Keep in Git', section: 'budget' },
  { key: 'videos.maxMb', label: 'Largest video', description: 'Size limit per video', section: 'budget' },
  { key: 'defaultWorker', label: 'Default worker', description: 'OpenCode, Claude Code, Kimi Code', section: 'budget' },
  { key: 'fleet.resumePauseTtlMin', label: 'Resume pause TTL', description: 'Warm resume window in minutes', section: 'budget' },
  { key: 'fleet.contextCapTokens', label: 'Context cap', description: 'Tokens before a worker compacts', section: 'budget' },
  { key: 'gitPath', label: 'Git executable', description: 'Only needed when git is not on PATH', section: 'budget' },
  { key: 'remote', label: 'Mission Control on other devices', description: 'Serve the phone and iPad app, port, Tailscale', section: 'devices' },
  { key: 'pairing', label: 'Pair a device', description: 'Pairing code and QR, revoke devices', section: 'devices' },
  { key: 'repository', label: 'Tickets repository', description: 'Path of the tickets folder', section: 'store' },
  { key: 'dk.checkout', label: 'Ticket store checkout', description: 'Working copy of the ticket branch', section: 'store' },
  { key: 'dk.syncSeconds', label: 'Sync interval', description: 'Seconds, remote stores only', section: 'store' },
  { key: 'repositories', label: 'Repositories', description: 'Launch command, default branch, found repositories', section: 'store' },
  { key: 'pipeline', label: 'Pipeline', description: 'Columns, handover mode, worker per column', section: 'pipeline' },
  { key: 'prompts', label: 'Prompts', description: 'Prompt files of the agent columns', section: 'pipeline' },
];
