import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import {
  AUTOPILOT_KINDS,
  autopilotRefusalCodeOf,
  autopilotRefusalKeyOf,
  resumeAtOfTime,
  timeFieldOfResume,
  type AutopilotKind,
  type AutopilotView,
} from '../../../../shared/autopilot';
import { MC_AUTOPILOT } from '../autopilot/autopilot-state';
import { McI18nPipe } from '../i18n/i18n.pipe';
import { PhoneIcon, type PhoneIconName } from '../phone/icon';
import { touchFaceSignal } from '../phone/phone';
import { AppBar } from '../app-bar/app-bar';
import { McI18n } from '../i18n/i18n.service';
import { deviceListOf } from './device-list';
import {
  ACCENTS,
  PHONE_ACCENTS,
  ACCENT_COLOR,
  ACCENT_LABEL,
  DEFAULT_TEXT_SIZE,
  TEXT_BODY_PX,
  TEXT_SCALE,
  TEXT_SIZES,
  THEMES,
  THEME_LABEL,
  THEME_SWATCH,
  Theme,
  type AccentName,
  type TextSize,
  type ThemeName,
} from '../theme';
import {
  MC_SETTINGS_STATE,
  countdownOf,
  groupedCode,
  qrPathOf,
  type McChatTest,
} from './settings.model';

/** The settings screen's pages. */
export type SettingsPage = 'appearance' | 'chat' | 'devices' | 'engine';

/** One row of the phone's Settings list (board 10g). */
interface PhoneSettingsRow {
  readonly id: SettingsPage;
  readonly icon: PhoneIconName;
  readonly label: string;
  readonly value: string;
}

export const SETTINGS_PAGES: readonly { readonly id: SettingsPage; readonly label: string; readonly sub: string }[] = [
  { id: 'appearance', label: 'Appearance', sub: 'Theme, highlight color, text size, density' },
  { id: 'chat', label: 'Chat', sub: 'Model, connection' },
  { id: 'devices', label: 'Devices', sub: 'Paired devices, revoke' },
  { id: 'engine', label: 'Engine', sub: 'Videos' },
];

/** The warning the "Videos in git" confirmation shows (specs/ticket-schema.md, "Videos"). */
export const VIDEOS_IN_GIT_WARNING =
  'Videos are large binary files. Once committed they stay in the history even if you delete them later, ' +
  'and the repository grows with every one. Keep this off unless you have a plan for the size (for example Git LFS).';

/**
 * The settings screen (E12-3, boards 5f / 5g / 6c): on a phone the list of
 * pages, then one page with a back button; from 768 px the list left and
 * the page right. Appearance is per device and applies at once (the Theme
 * service, localStorage); Devices and Engine are per vault and read and
 * write the desk through `MC_SETTINGS_STATE`.
 */
@Component({
  selector: 'mc-settings',
  templateUrl: './settings.html',
  styleUrls: ['../phone/kit.css', './settings.css'],
  imports: [AppBar, McI18nPipe, NgTemplateOutlet, PhoneIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  protected readonly theme = inject(Theme);
  private readonly state = inject(MC_SETTINGS_STATE, { optional: true });
  private readonly i18n = inject(McI18n);

  // --- the phone's list and Appearance (boards 10g, 10h) --------------------------

  protected readonly phone = touchFaceSignal();
  private readonly autopilotState = inject(MC_AUTOPILOT, { optional: true });
  protected readonly query = signal('');
  protected readonly phoneAccents = PHONE_ACCENTS;
  protected readonly autopilotKinds = AUTOPILOT_KINDS;
  protected readonly autopilot = computed(() => this.autopilotState?.autopilot() ?? null);
  protected readonly autopilotReadOnly = computed(() => this.autopilotState?.readOnly() ?? true);
  protected readonly autopilotError = signal<string | null>(null);
  /** The Resume row's time; the field is empty until one is set. */
  protected readonly resumeTime = computed(() => timeFieldOfResume(this.autopilot()?.resumeAt));

  /** The rows by where they apply; Away and alerts and Repositories wait for E12-3b. */
  protected readonly phoneGroups = computed(() => {
    const needle = this.query().trim().toLowerCase();
    const row = (id: SettingsPage, icon: PhoneIconName): PhoneSettingsRow => ({
      id,
      icon,
      label: this.labelOf(id),
      value: this.phoneValueOf(id),
    });
    const groups = [
      { key: 'device', label: this.i18n.t('settings.phone.this_device'), rows: [row('appearance', 'contrast'), row('chat', 'chat')] },
      { key: 'all', label: this.i18n.t('settings.phone.all_devices'), rows: [row('devices', 'device'), row('engine', 'terminal')] },
    ];
    return groups
      .map((group) => ({ ...group, rows: group.rows.filter((r) => needle === '' || r.label.toLowerCase().includes(needle)) }))
      .filter((group) => group.rows.length > 0);
  });

  /** The right-hand value the board draws for a row. */
  private phoneValueOf(id: SettingsPage): string {
    switch (id) {
      case 'chat':
        return '';
      case 'engine':
        return this.view() === null ? '' : this.i18n.t('settings.phone.engine_running');
      default:
        return this.summaryOf(id);
    }
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected async pickAutopilot(state: AutopilotKind): Promise<void> {
    await this.writeAutopilot({ state });
  }

  protected async onResumeTime(event: Event): Promise<void> {
    const at = resumeAtOfTime((event.target as HTMLInputElement).value, new Date());
    if (at !== null) {
      await this.writeAutopilot({ state: 'paused', resumeAt: at });
    }
  }

  private async writeAutopilot(record: AutopilotView): Promise<void> {
    this.autopilotError.set(null);
    const reply = await this.autopilotState?.set(record);
    if (reply !== undefined && !reply.ok) {
      this.autopilotError.set(this.i18n.t(autopilotRefusalKeyOf(reply.code ?? autopilotRefusalCodeOf(reply))));
    }
  }

  protected sizeValueText(): string {
    const size = this.theme.textSize();
    return `${size}, ${TEXT_BODY_PX[size]} px`;
  }

  /** A tap or drag start on the slider takes the nearest of the five steps. */
  protected onSlider(event: PointerEvent, slider: HTMLElement): void {
    const box = slider.getBoundingClientRect();
    const step = Math.round(((event.clientX - box.left) / Math.max(1, box.width)) * (this.sizes.length - 1));
    const size = this.sizes[Math.min(this.sizes.length - 1, Math.max(0, step))];
    if (size !== undefined) {
      this.pickSize(size);
    }
  }

  protected onSliderKey(event: KeyboardEvent): void {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    const size = this.sizes[this.sizeIndex() + delta];
    if (delta !== 0 && size !== undefined) {
      event.preventDefault();
      this.pickSize(size);
    }
  }

  protected readonly pages = SETTINGS_PAGES;
  protected readonly themes = THEMES;
  protected readonly accents = ACCENTS;
  protected readonly sizes = TEXT_SIZES;
  protected readonly warning = VIDEOS_IN_GIT_WARNING;

  /** The phone's open page; null = the list. On the wide layout Appearance stands in. */
  protected readonly page = signal<SettingsPage | null>(null);
  private readonly wideQuery = typeof matchMedia === 'function' ? matchMedia('(min-width: 768px)') : null;
  protected readonly wide = signal(this.wideQuery?.matches ?? false);

  protected readonly shown = computed<SettingsPage | null>(() => this.page() ?? (this.wide() ? 'appearance' : null));
  protected readonly view = computed(() => this.state?.settings() ?? null);
  protected readonly error = computed(() => this.state?.settingsError() ?? null);

  /** The "Videos in git" confirmation dialog is up. */
  protected readonly confirming = signal(false);
  /** The dialog's "Include the n existing videos" tick. */
  protected readonly includeExisting = signal(false);
  /** The device whose revoke button was pressed once. */
  protected readonly armed = signal<string | null>(null);
  protected readonly maxDraft = signal<string | null>(null);

  /** The preview card's colours follow the chosen theme and highlight. */
  protected readonly previewAccent = computed(() => this.accentColor(this.theme.accent()));
  protected readonly previewSwatch = computed(() => THEME_SWATCH[this.theme.name()]);

  constructor() {
    this.wideQuery?.addEventListener('change', () => this.wide.set(this.wideQuery?.matches ?? false));
    void this.state?.load();
    void this.state?.refreshPairing?.();
    const timer = setInterval(() => this.tick(), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected open(page: SettingsPage): void {
    this.page.set(page);
  }

  protected back(): void {
    this.page.set(null);
  }

  protected labelOf(id: SettingsPage): string {
    return this.pages.find((p) => p.id === id)?.label ?? '';
  }

  /** The list's right-hand hint for a page. */
  protected summaryOf(id: SettingsPage): string {
    switch (id) {
      case 'appearance':
        return `${THEME_LABEL[this.theme.name()]} · ${this.theme.textSize()}`;
      case 'chat': {
        const chat = this.view()?.chat;
        return chat === undefined || chat === null ? '' : (chat.model ?? 'No model');
      }
      case 'devices': {
        const count = this.view()?.devices.length;
        return count === undefined ? '' : `${count} paired`;      }
      case 'engine': {
        const videos = this.view()?.videos;
        return videos === undefined
          ? ''
          : this.i18n.t(videos.inGit ? 'settings.engine.summary_in_git' : 'settings.engine.summary_out', { mb: videos.maxMb });
      }
    }
  }

  // -- appearance -------------------------------------------------------------

  protected themeLabel(name: ThemeName): string {
    return THEME_LABEL[name];
  }

  protected swatch(name: ThemeName): { readonly bg: string; readonly panel: string; readonly accent: string } {
    return THEME_SWATCH[name];
  }

  protected accentLabel(name: AccentName): string {
    return ACCENT_LABEL[name];
  }

  /** The dot's colour: the override, or the current theme's own accent. */
  protected accentColor(name: AccentName): string {
    return name === 'default' ? THEME_SWATCH[this.theme.name()].accent : ACCENT_COLOR[name];
  }

  /** The preview's first line: the step, its body size, and whether it is the default. */
  protected previewLine(size: TextSize): string {
    return `${size} · ${TEXT_BODY_PX[size]} px body text${size === DEFAULT_TEXT_SIZE ? ", the default" : ""}`;
  }

  protected scaled(size: TextSize, base: number): number {
    return Math.round(base * TEXT_SCALE[size]);
  }

  protected pickTheme(name: ThemeName): void {
    this.theme.set(name);
  }

  protected pickAccent(name: AccentName): void {
    this.theme.setAccent(name);
  }

  protected pickSize(size: TextSize): void {
    this.theme.setTextSize(size);
  }

  /** The chosen step's place on the control (0 = S); the steps up to it are tinted. */
  protected readonly sizeIndex = computed(() => this.sizes.indexOf(this.theme.textSize()));

  protected onCompact(event: Event): void {
    this.theme.setCompact((event.target as HTMLInputElement).checked);
  }

  protected onMotion(event: Event): void {
    this.theme.setReduceMotion((event.target as HTMLInputElement).checked);
  }

  // -- chat -------------------------------------------------------------------

  /** True while "Test connection" waits for the endpoint. */
  protected readonly testing = signal(false);
  protected readonly tested = signal<McChatTest | null>(null);
  protected readonly canTest = computed(() => this.state?.testChat !== undefined);

  protected async testChat(): Promise<void> {
    if (this.state?.testChat === undefined || this.testing()) {
      return;
    }
    this.testing.set(true);
    this.tested.set(null);
    try {
      this.tested.set(await this.state.testChat());
    } catch (err) {
      this.tested.set({ ok: false, message: err instanceof Error ? err.message : 'The test failed.' });
    } finally {
      this.testing.set(false);
    }
  }

  // -- devices ----------------------------------------------------------------

  /** The clock the list's "3 h ago" and the countdown read; one tick a second. */
  protected readonly now = signal(Date.now());

  /** The heading with the total and one row per device (D-2). */
  protected readonly list = computed(() => deviceListOf(this.view()?.devices ?? [], this.now()));

  /** This device may mint others: it is known and not read-only. */
  protected readonly canPair = computed(() => {
    const me = this.view()?.devices.find((d) => d.current);
    return this.state?.startPairing !== undefined && me !== undefined && !me.readOnly;
  });
  protected readonly waiting = computed(() => this.state?.pairingView?.() ?? null);
  protected readonly pairName = signal('');
  protected readonly pairReadOnly = signal(false);
  protected readonly pairBusy = signal(false);

  protected readonly code = computed(() => groupedCode(this.waiting()?.pairing?.code ?? ''));
  protected readonly qr = computed(() => qrPathOf(this.waiting()?.pairing?.qr ?? []));
  protected readonly countdown = computed(() => {
    const p = this.waiting()?.pairing;
    return p === null || p === undefined ? '' : countdownOf(p.expiresAt, this.now());
  });

  private ticks = 0;

  /** One second: the clock moves; while a pairing waits, the engine is asked now and then. */
  protected tick(): void {
    this.now.set(Date.now());
    if (this.waiting()?.pairing !== null && this.waiting()?.pairing !== undefined && ++this.ticks % 3 === 0) {
      void this.state?.refreshPairing?.();
    }
  }

  protected onPairName(event: Event): void {
    this.pairName.set((event.target as HTMLInputElement).value);
  }

  protected onPairReadOnly(event: Event): void {
    this.pairReadOnly.set((event.target as HTMLInputElement).checked);
  }

  protected async startPairing(): Promise<void> {
    if (this.state?.startPairing === undefined || this.pairBusy()) {
      return;
    }
    this.pairBusy.set(true);
    try {
      await this.state.startPairing(this.pairName().trim(), this.pairReadOnly());
    } finally {
      this.pairBusy.set(false);
    }
  }

  protected async cancelPairing(): Promise<void> {
    await this.state?.cancelPairing?.();
  }

  /** First press arms, the second revokes. */
  protected async revokeId(id: string): Promise<void> {
    if (this.armed() !== id) {
      this.armed.set(id);
      return;
    }
    this.armed.set(null);
    await this.state?.revokeDevice(id);
  }

  // -- engine -----------------------------------------------------------------

  /** The switch: off applies at once, on asks first. */
  protected onVideosInGit(event: Event): void {
    const box = event.target as HTMLInputElement;
    if (box.checked) {
      box.checked = false;
      this.includeExisting.set(false);
      this.confirming.set(true);
      return;
    }
    void this.state?.setVideosInGit(false, false);
  }

  protected onIncludeExisting(event: Event): void {
    this.includeExisting.set((event.target as HTMLInputElement).checked);
  }

  protected cancelConfirm(): void {
    this.confirming.set(false);
  }

  protected async confirmInGit(): Promise<void> {
    this.confirming.set(false);
    await this.state?.setVideosInGit(true, true, this.includeExisting());
  }

  protected onMaxInput(event: Event): void {
    this.maxDraft.set((event.target as HTMLInputElement).value);
  }

  /** A typed value commits when the field is left or on Enter. */
  protected async commitMax(): Promise<void> {
    const draft = this.maxDraft();
    this.maxDraft.set(null);
    if (draft === null || this.view() === null) {
      return;
    }
    const mb = Number(draft);
    if (Number.isInteger(mb) && mb >= 1 && mb <= 200 && mb !== this.view()?.videos.maxMb) {
      await this.state?.setVideoMaxMb(mb);
    }
  }
}
