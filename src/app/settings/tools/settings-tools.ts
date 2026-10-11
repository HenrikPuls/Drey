import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import {
  McpClientServer,
  PROVIDER_PRESETS,
  ToolApprovalMode,
  ToolWriteMode,
  mcpServerSlug,
} from '../../../../shared/app-config';
import { McpClientServerStatus } from '../../../../shared/ipc-api';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/** `KEY=value` (or `Name: value`) lines as a map; malformed lines are dropped. */
export function parsePairs(text: string, separator: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const cut = line.indexOf(separator);
    const key = cut > 0 ? line.slice(0, cut).trim() : '';
    if (key !== '') {
      out[key] = line.slice(cut + 1).trim();
    }
  }
  return out;
}

export function formatPairs(pairs: Record<string, string>, separator: '=' | ':'): string {
  return Object.entries(pairs)
    .map(([key, value]) => (separator === '=' ? `${key}=${value}` : `${key}: ${value}`))
    .join('\n');
}

/**
 * "Assistant tools" settings category (milestone 63, ADR-0063): what the
 * built-in assistant may call -- one switch per tool group, the write rule
 * of the writing groups, and the external sources (web fetch, MCP servers)
 * with their approval rule.
 *
 * Pure view over the draft; Save persists it and main connects / drops the
 * servers to match.
 */
@Component({
  selector: 'app-settings-tools',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-tools.html',
  styleUrls: ['./settings-tools.css'],
})
export class SettingsTools {
  protected readonly settings = inject(SettingsService);

  protected readonly tools = computed(() => this.settings.draft()?.tools ?? null);
  protected readonly status = signal<McpClientServerStatus[]>([]);
  /** Whether the provider in the draft runs a tool loop at all. */
  protected readonly providerHasTools = computed(() => {
    const provider = this.settings.draft()?.llm.provider;
    return provider === undefined || PROVIDER_PRESETS[provider].capabilities.tools;
  });

  protected readonly formatPairs = formatPairs;

  constructor() {
    // The status follows the SAVED config; connecting takes a moment, so
    // look again shortly after every save.
    effect((onCleanup) => {
      this.settings.config();
      void this.refreshStatus();
      const timer = setTimeout(() => void this.refreshStatus(), 2500);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected statusOf(id: string): McpClientServerStatus | null {
    return this.status().find((s) => s.id === id) ?? null;
  }

  /** Whether the draft differs from what main is connected to. */
  protected isUnsaved(server: McpClientServer): boolean {
    const saved = this.settings.config()?.tools.servers.find((s) => s.id === server.id);
    return saved === undefined || JSON.stringify(saved) !== JSON.stringify(server);
  }

  protected setVaultEnabled(on: boolean): void {
    this.settings.patchTools((t) => void (t.vault.enabled = on));
  }

  protected setVaultWrite(mode: string): void {
    this.settings.patchTools((t) => void (t.vault.write = this.writeMode(mode)));
  }

  protected setTasksEnabled(on: boolean): void {
    this.settings.patchTools((t) => void (t.tasks.enabled = on));
  }

  protected setTemplatesEnabled(on: boolean): void {
    this.settings.patchTools((t) => void (t.templates.enabled = on));
  }

  protected setTemplatesWrite(mode: string): void {
    this.settings.patchTools((t) => void (t.templates.write = this.writeMode(mode)));
  }

  protected setWebFetchEnabled(on: boolean): void {
    this.settings.patchTools((t) => void (t.webFetch.enabled = on));
  }

  protected setWebFetchApproval(mode: string): void {
    this.settings.patchTools((t) => void (t.webFetch.approval = this.approvalMode(mode)));
  }

  protected addServer(): void {
    this.settings.patchTools((t) => {
      t.servers.push({
        id: this.uniqueId('server', t.servers, null),
        name: 'New server',
        enabled: true,
        approval: 'ask',
        transport: { kind: 'stdio', command: '', args: [], env: {} },
      });
    });
  }

  protected removeServer(id: string): void {
    this.settings.patchTools((t) => {
      t.servers = t.servers.filter((s) => s.id !== id);
    });
  }

  protected patchServer(id: string, change: (server: McpClientServer) => void): void {
    this.settings.patchTools((t) => {
      const server = t.servers.find((s) => s.id === id);
      if (server) {
        change(server);
      }
    });
  }

  /**
   * The id is the tool prefix the model sees. It follows the name until
   * the server has been saved once, then stays -- a later rename must not
   * change tool names recorded in existing chats.
   */
  protected setName(id: string, name: string): void {
    const saved = this.settings.config()?.tools.servers.some((s) => s.id === id) ?? false;
    this.settings.patchTools((t) => {
      const server = t.servers.find((s) => s.id === id);
      if (!server) {
        return;
      }
      server.name = name;
      if (!saved) {
        server.id = this.uniqueId(mcpServerSlug(name) || 'server', t.servers, server);
      }
    });
  }

  protected setKind(id: string, kind: string): void {
    this.patchServer(id, (server) => {
      if (kind === server.transport.kind) {
        return;
      }
      server.transport =
        kind === 'http'
          ? { kind: 'http', url: '', headers: {} }
          : { kind: 'stdio', command: '', args: [], env: {} };
    });
  }

  protected setCommand(id: string, command: string): void {
    this.patchServer(id, (server) => {
      if (server.transport.kind === 'stdio') {
        server.transport.command = command.trim();
      }
    });
  }

  protected setArgs(id: string, text: string): void {
    this.patchServer(id, (server) => {
      if (server.transport.kind === 'stdio') {
        server.transport.args = text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '');
      }
    });
  }

  protected setEnv(id: string, text: string): void {
    this.patchServer(id, (server) => {
      if (server.transport.kind === 'stdio') {
        server.transport.env = parsePairs(text, '=');
      }
    });
  }

  protected setUrl(id: string, url: string): void {
    this.patchServer(id, (server) => {
      if (server.transport.kind === 'http') {
        server.transport.url = url.trim();
      }
    });
  }

  protected setHeaders(id: string, text: string): void {
    this.patchServer(id, (server) => {
      if (server.transport.kind === 'http') {
        server.transport.headers = parsePairs(text, ':');
      }
    });
  }

  protected setServerEnabled(id: string, on: boolean): void {
    this.patchServer(id, (server) => void (server.enabled = on));
  }

  protected argsText(args: readonly string[]): string {
    return args.join('\n');
  }

  protected toolSummary(tools: readonly string[]): string {
    const count = `${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`;
    return tools.length === 0 ? count : `${count}: ${tools.join(', ')}`;
  }

  protected setServerApproval(id: string, mode: string): void {
    this.patchServer(id, (server) => void (server.approval = this.approvalMode(mode)));
  }

  protected async reconnect(id: string): Promise<void> {
    const next = await window.dreyApi?.reconnectToolServer?.(id);
    if (next) {
      this.status.set(next);
    }
  }

  private async refreshStatus(): Promise<void> {
    const next = await window.dreyApi?.getToolsStatus?.();
    if (next) {
      this.status.set(next);
    }
  }

  private uniqueId(base: string, servers: readonly McpClientServer[], self: McpClientServer | null): string {
    const taken = new Set(servers.filter((s) => s !== self).map((s) => s.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) {
      id = `${base}-${n}`;
    }
    return id;
  }

  private writeMode(mode: string): ToolWriteMode {
    return mode === 'auto' ? 'auto' : 'confirm';
  }

  private approvalMode(mode: string): ToolApprovalMode {
    return mode === 'allow' ? 'allow' : 'ask';
  }
}
