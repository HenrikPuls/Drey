import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { MCP_PORT_MAX, MCP_PORT_MIN } from '../../../../shared/app-config';
import { McpStatus } from '../../../../shared/ipc-api';
import { ConfirmDialogService } from '../../services/confirm-dialog.service';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "MCP" settings category (ADR-0021): the vault MCP server -- an enable
 * switch, the optional localhost HTTP endpoint + port, the "YOLO mode"
 * write-without-confirmation switch (off, and meant to stay off), and a
 * copy-paste client config snippet for the stdio bridge.
 *
 * Pure view over the self-saving draft; a save also (re)starts / stops the
 * HTTP endpoint in the main process, so the status line is re-read after
 * each one. Turning YOLO mode *on* asks first -- it takes effect at once.
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
  private readonly dialogs = inject(ConfirmDialogService);
  protected readonly portMin = MCP_PORT_MIN;
  protected readonly portMax = MCP_PORT_MAX;

  protected readonly mcp = computed(() => this.settings.draft()?.mcp ?? null);
  protected readonly status = signal<McpStatus | null>(null);
  protected readonly copied = signal(false);

  constructor() {
    // The status follows the SAVED config; the endpoint takes a moment to
    // open or close, so look again shortly after every save.
    effect((onCleanup) => {
      this.settings.config();
      this.refreshStatus();
      const timer = setTimeout(() => this.refreshStatus(), 800);
      onCleanup(() => clearTimeout(timer));
    });
  }

  private refreshStatus(): void {
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

  protected async onYoloChange(box: HTMLInputElement): Promise<void> {
    const on = box.checked;
    if (on) {
      const confirmed = await this.dialogs.confirm({
        title: 'Turn on YOLO mode?',
        message:
          'MCP clients will then change vault files immediately, with no diff to approve. This takes effect right away.',
        confirmLabel: 'Turn on',
        danger: true,
      });
      if (!confirmed) {
        box.checked = false;
        return;
      }
    }
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
