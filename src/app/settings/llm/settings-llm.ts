import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  LlmProviderId,
  PROVIDER_PRESETS,
  PROVIDER_PRESET_IDS,
} from '../../../../shared/app-config';
import { LlmDebugEntry } from '../../../../shared/ipc-api';
import { LlmCapabilities, maskSecret, toCurl } from '../../../../shared/llm';
import { LlmDebugService } from '../../llm';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "LLM" settings category: the provider select (ADR-0047), then the
 * per-provider fields -- for the HTTP presets the base URL, the bearer API
 * key, a model box filled from a live model listing (but free-form, so a
 * server that doesn't expose one can still be driven), a connection test,
 * and a debug log of every request the app has sent this session.
 *
 * Pure view -- every config change goes through `SettingsService.patchLlm`,
 * which writes the *draft*; nothing reaches disk until Save.
 */
@Component({
  selector: 'app-settings-llm',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-llm.html',
  styleUrls: ['../settings-forms.css', './settings-llm.css'],
})
export class SettingsLlm implements OnInit, OnDestroy {
  protected readonly settings = inject(SettingsService);
  protected readonly debug = inject(LlmDebugService);

  /** The provider catalogue and the draft's active id. */
  protected readonly providerIds = PROVIDER_PRESET_IDS;
  protected readonly presets = PROVIDER_PRESETS;
  protected readonly activePreset = computed(
    () => PROVIDER_PRESETS[this.llm()?.provider ?? 'lmstudio'],
  );

  /** The draft's LLM block -- edits stay local until the screen is saved. */
  protected readonly llm = computed(() => this.settings.draft()?.llm ?? null);

  /** Newest first: when you are debugging you care about the last attempt. */
  protected readonly entries = computed<LlmDebugEntry[]>(() => [...this.debug.entries()].reverse());

  /** Which entry's detail is expanded. */
  protected readonly openEntry = signal<number | null>(null);
  /** Entry id whose curl was just copied, for the transient "Copied" label. */
  protected readonly copied = signal<number | null>(null);
  /** Reveal the API key as plain text (to check what is actually stored). */
  protected readonly showApiKey = signal(false);

  /** Highest entry id already auto-expanded, so a collapse isn't undone on re-render. */
  private lastAutoOpened = 0;

  /** The key as *persisted*, masked -- "is a key actually saved?" at a glance. */
  protected readonly savedKeyMask = computed<string | null>(() => {
    const key = this.settings.config()?.llm.apiKey;
    return key ? maskSecret(key) : null;
  });

  /** The draft's key differs from the saved one -- i.e. it still needs Save. */
  protected readonly apiKeyUnsaved = computed<boolean>(
    () =>
      (this.settings.draft()?.llm.apiKey ?? null) !== (this.settings.config()?.llm.apiKey ?? null),
  );

  /** The configured model plus anything the endpoint currently lists, de-duplicated. */
  protected readonly modelOptions = computed<string[]>(() => {
    const current = this.llm()?.model;
    const listed = this.settings.models();
    return current && !listed.includes(current) ? [current, ...listed] : listed;
  });

  /**
   * The most common 401 cause, called out explicitly: the app sent no
   * `Authorization` header at all. That is a different problem from a key
   * the server rejects -- usually a stale main process (see docs/11) or a
   * key that was typed but never saved.
   */
  protected readonly unauthorizedWithoutKey = computed<boolean>(() => {
    const last = this.entries()[0];
    return !!last && (last.status === 401 || last.status === 403) && !last.authSent;
  });

  constructor() {
    // Auto-expand each newly arriving entry: while debugging, the request
    // you just triggered is the one you want to read. Guarded by id so
    // collapsing it manually isn't undone by an unrelated re-render.
    effect(() => {
      const newest = this.debug.entries().at(-1);
      if (newest && newest.id > this.lastAutoOpened) {
        this.lastAutoOpened = newest.id;
        this.openEntry.set(newest.id);
      }
    });
  }

  ngOnInit(): void {
    void this.debug.start();
  }

  ngOnDestroy(): void {
    this.debug.stop();
  }

  protected onEnabledChange(enabled: boolean): void {
    this.settings.patchLlm({ enabled });
    if (enabled) {
      void this.settings.refreshModels();
    }
  }

  /**
   * Switching provider pre-fills the draft's base URL from the preset
   * (draft-side only -- `chat()` always uses the saved config, so the
   * switch needs a Save either way). The model stays as-is: many presets
   * share id conventions, and blanking a typed id would be rude.
   */
  protected onProviderChange(provider: LlmProviderId): void {
    const preset = PROVIDER_PRESETS[provider];
    this.settings.patchLlm({
      provider,
      ...(preset.defaultBaseUrl !== null ? { baseUrl: preset.defaultBaseUrl } : {}),
    });
    if (preset.capabilities.modelListing) {
      void this.settings.refreshModels();
    }
  }

  /** Cloud presets need a key before anything works; local ones usually don't. */
  protected keyRequired(): boolean {
    return this.activePreset().requiresApiKey;
  }

  /** One line per missing capability, so the degradation is visible up front. */
  protected capabilityHints(capabilities: LlmCapabilities): string[] {
    const hints: string[] = [];
    if (!capabilities.tools) {
      hints.push('no in-app tool use — Ask runs without the vault tools');
    }
    if (!capabilities.modelListing) {
      hints.push('no model listing — type the model id by hand');
    }
    if (!capabilities.imageAttachments) {
      hints.push('no image attachments');
    }
    if (!capabilities.streaming) {
      hints.push('no streaming');
    }
    return hints;
  }

  /** The not-yet-wired presets (they ship with the provider program — see specs/roadmap.md). */
  protected readonly pendingProviderNote = computed<string | null>(() => {
    const notes: Partial<Record<LlmProviderId, string>> = {
      'copilot-cli':
        'The GitHub Copilot CLI provider is not wired into this build yet — planned on the provider roadmap (specs/roadmap.md).',
      'copilot-web':
        'The Copilot Web provider (browser automation) is not merged into this build yet — planned on the provider roadmap (specs/roadmap.md).',
    };
    return notes[this.llm()?.provider ?? 'lmstudio'] ?? null;
  });

  // These fire on every keystroke and write straight into the draft. The
  // value is stored *verbatim*: trimming here would rewrite the bound
  // `[value]` mid-typing and eat the space the user just pressed.
  // `normalizeAppConfig` trims on save, which is where it belongs.

  protected onBaseUrlChange(baseUrl: string): void {
    this.settings.patchLlm({ baseUrl });
  }

  /** Bearer token; empty clears it (LM Studio needs none, Unsloth Desktop does). */
  protected onApiKeyChange(apiKey: string): void {
    this.settings.patchLlm({ apiKey: apiKey === '' ? null : apiKey });
  }

  protected onModelChange(model: string): void {
    this.settings.patchLlm({ model: model === '' ? null : model });
  }

  protected toggleEntry(id: number): void {
    this.openEntry.update((current) => (current === id ? null : id));
  }

  /** The masked, display-safe command shown in the panel. */
  protected curlFor(entry: LlmDebugEntry): string {
    return toCurl(entry);
  }

  /**
   * Puts a *working* curl on the clipboard -- the real key is substituted
   * for the mask. Deliberate, explicit action: the panel itself stays
   * safe to screenshot.
   */
  protected async copyCurl(entry: LlmDebugEntry): Promise<void> {
    const command = toCurl(entry, this.llm()?.apiKey ?? null);
    try {
      await navigator.clipboard.writeText(command);
      this.copied.set(entry.id);
      setTimeout(() => {
        if (this.copied() === entry.id) {
          this.copied.set(null);
        }
      }, 1500);
    } catch {
      // Clipboard denied -- the command is visible in the panel to copy by hand.
    }
  }
}
