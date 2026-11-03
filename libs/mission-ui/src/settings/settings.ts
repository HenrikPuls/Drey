import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  ACCENTS,
  ACCENT_COLOR,
  ACCENT_LABEL,
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
import { MC_SETTINGS_STATE, type McSettingsDevice } from './settings.model';

/** The settings screen's pages. */
export type SettingsPage = 'appearance' | 'devices' | 'engine';

export const SETTINGS_PAGES: readonly { readonly id: SettingsPage; readonly label: string; readonly sub: string }[] = [
  { id: 'appearance', label: 'Appearance', sub: 'Theme, highlight color, text size, density' },
  { id: 'devices', label: 'Devices', sub: 'Paired devices, revoke' },
  { id: 'engine', label: 'Engine', sub: 'Videos, size limit' },
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
  styleUrl: './settings.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Settings {
  protected readonly theme = inject(Theme);
  private readonly state = inject(MC_SETTINGS_STATE, { optional: true });

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
  protected readonly limitDraft = signal<string | null>(null);

  /** The preview card's colours follow the chosen theme and highlight. */
  protected readonly previewAccent = computed(() => this.accentColor(this.theme.accent()));
  protected readonly previewSwatch = computed(() => THEME_SWATCH[this.theme.name()]);

  constructor() {
    this.wideQuery?.addEventListener('change', () => this.wide.set(this.wideQuery?.matches ?? false));
    void this.state?.load();
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
      case 'devices': {
        const count = this.view()?.devices.length;
        return count === undefined ? '' : `${count} paired`;
      }
      case 'engine':
        return '';
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

  protected onCompact(event: Event): void {
    this.theme.setCompact((event.target as HTMLInputElement).checked);
  }

  protected onMotion(event: Event): void {
    this.theme.setReduceMotion((event.target as HTMLInputElement).checked);
  }

  // -- devices ----------------------------------------------------------------

  protected seenOf(device: McSettingsDevice): string {
    const at = device.lastSeen ?? device.pairedAt;
    const date = Date.parse(at);
    return Number.isNaN(date) ? '' : `${device.lastSeen === null ? 'Paired' : 'Seen'} ${new Date(date).toLocaleDateString()}`;
  }

  /** First press arms, the second revokes. */
  protected async revoke(device: McSettingsDevice): Promise<void> {
    if (this.armed() !== device.id) {
      this.armed.set(device.id);
      return;
    }
    this.armed.set(null);
    await this.state?.revokeDevice(device.id);
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

  protected onLimitInput(event: Event): void {
    this.limitDraft.set((event.target as HTMLInputElement).value);
  }

  /** A typed value commits when the field is left or on Enter. */
  protected async commitLimit(): Promise<void> {
    const draft = this.limitDraft();
    this.limitDraft.set(null);
    if (draft === null || this.view() === null) {
      return;
    }
    const mb = Number(draft);
    if (Number.isInteger(mb) && mb !== this.view()?.videos.limitMb) {
      await this.state?.setVideoLimit(mb);
    }
  }
}
