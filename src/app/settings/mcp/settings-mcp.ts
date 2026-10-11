import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MCP_PORT_MAX, MCP_PORT_MIN } from '../../../../shared/app-config';
import { McpStatus } from '../../../../shared/ipc-api';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "MCP" settings category (ADR-0021): the vault MCP server -- an enable
 * switch, the optional localhost HTTP endpoint + port, the "YOLO mode"
 * write-without-confirmation switch (off, and meant to stay off), and a
 * copy-paste client config snippet for the stdio bridge.
 *
 * Pure view; changes go into the draft and reach disk on Save. `Save`
 * also (re)starts / stops the HTTP endpoint in the main process.
 */
@Component({
  selector: 'app-settings-mcp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-mcp.html',
  styleUrls: ['./settings-mcp.css'],
})
export class SettingsMcp {
  protected readonly settings = inject(SettingsService);
  protected readonly portMin = MCP_PORT_MIN;
  protected readonly portMax = MCP_PORT_MAX;

  protected readonly mcp = computed(() => this.settings.draft()?.mcp ?? null);
  protected readonly status = signal<McpStatus | null>(null);
  protected readonly copied = signal(false);

  constructor() {
    void window.dreyApi?.getMcpStatus?.().then((s) => this.status.set(s));
  }

  /** The config block an external MCP client (Claude Desktop, …) pastes in. */
  protected readonly clientSnippet = computed<string>(() => {
    const port = this.mcp()?.httpPort ?? 4319;
    const bridge =
      this.status()?.stdioBridgePath ?? '<drey>/dist-electron/electron/mcp/stdio-bridge.js';
    return JSON.stringify(
      {
        mcpServers: {
          'drey-vault': {
            command: 'node',
            args: [bridge],
            env: { DREY_MCP_PORT: String(port) },
          },
        },
      },
      null,
      2,
    );
  });

  protected onEnabledChange(on: boolean): void {
    this.settings.patchMcp({ enabled: on });
  }

  protected onHttpEnabledChange(on: boolean): void {
    this.settings.patchMcp({ httpEnabled: on });
  }

  protected onPortChange(value: string): void {
    const n = Number(value);
    if (Number.isInteger(n)) {
      this.settings.patchMcp({ httpPort: n });
    }
  }

  protected onYoloChange(on: boolean): void {
    this.settings.patchMcp({ yolo: on });
  }

  protected async copySnippet(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.clientSnippet());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Clipboard blocked -- the snippet is visible for a manual copy.
    }
  }
}
