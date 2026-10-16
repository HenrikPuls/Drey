import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppConfig, normalizeAppConfig } from '../../../../shared/app-config';
import { CaptureHotkeyStatus, DreyApi } from '../../../../shared/ipc-api';
import { KeybindingService } from '../../keybindings';
import { SettingsService } from '../../services/settings.service';
import { SettingsShortcuts } from './settings-shortcuts';

describe('SettingsShortcuts (ADR-0073)', () => {
  let fixture: ComponentFixture<SettingsShortcuts>;
  let settings: SettingsService;
  let keys: KeybindingService;
  let captureStatus: CaptureHotkeyStatus;
  let runs: number;

  beforeEach(async () => {
    let disk = normalizeAppConfig({});
    captureStatus = { chord: 'Mod+Alt+N', registered: true };
    window.dreyApi = {
      getConfig: () => Promise.resolve(structuredClone(disk)),
      setConfig: (config: AppConfig) => {
        disk = normalizeAppConfig(config);
        return Promise.resolve(structuredClone(disk));
      },
      getCaptureHotkeyStatus: () => Promise.resolve(captureStatus),
    } as Partial<DreyApi> as DreyApi;

    keys = TestBed.inject(KeybindingService);
    runs = 0;
    keys.register({ id: 'note.new', label: 'New note', keybinding: 'Mod+N', run: () => runs++ });
    keys.register({ id: 'note.save', label: 'Save', keybinding: 'Mod+S', run: () => runs++ });

    settings = TestBed.inject(SettingsService);
    await settings.load();
    settings.openScreen();
    fixture = TestBed.createComponent(SettingsShortcuts);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  function rowOf(label: string): HTMLElement {
    const row = Array.from(el().querySelectorAll<HTMLElement>('.shortcuts li')).find(
      (li) => li.querySelector('.name')?.textContent?.trim() === label,
    );
    if (!row) {
      throw new Error(`no row ${label}`);
    }
    return row;
  }

  function button(row: HTMLElement, text: string): HTMLButtonElement {
    const found = Array.from(row.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
    if (!found) {
      throw new Error(`no button ${text}`);
    }
    return found;
  }

  function pressKey(init: KeyboardEventInit): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { ...init, cancelable: true }));
    fixture.detectChanges();
  }

  it('lists the quick-capture hotkey and the commands with their chords', () => {
    expect(rowOf('Quick capture (system-wide)').querySelector('.chord')?.textContent).toContain('Ctrl Alt N');
    expect(rowOf('New note').querySelector('.chord')?.textContent).toContain('Ctrl N');
  });

  it('records a pressed chord into the draft without running the command it held', () => {
    button(rowOf('New note'), 'Change').click();
    fixture.detectChanges();
    pressKey({ key: 'Control', ctrlKey: true }); // modifiers alone: still waiting
    pressKey({ key: 'K', ctrlKey: true, shiftKey: true });

    expect(settings.draft()?.keybindings.overrides).toEqual({ 'note.new': 'Mod+Shift+K' });
    expect(rowOf('New note').querySelector('.chord')?.textContent).toContain('Ctrl Shift K');
    expect(runs).toBe(0);
  });

  it('Esc cancels the recording', () => {
    button(rowOf('New note'), 'Change').click();
    fixture.detectChanges();
    pressKey({ key: 'Escape' });

    expect(settings.draft()?.keybindings.overrides).toEqual({});
    expect(rowOf('New note').classList.contains('recording')).toBe(false);
  });

  it('refuses a reserved chord with a message', () => {
    button(rowOf('New note'), 'Change').click();
    fixture.detectChanges();
    pressKey({ key: 'c', ctrlKey: true });

    expect(settings.draft()?.keybindings.overrides).toEqual({});
    expect(rowOf('New note').textContent).toContain('is used by the editor');
  });

  it('asks before taking a chord another command holds, and Replace leaves that one without', () => {
    button(rowOf('New note'), 'Change').click();
    fixture.detectChanges();
    pressKey({ key: 's', ctrlKey: true });

    expect(rowOf('New note').textContent).toContain('is held by “Save”');
    expect(settings.draft()?.keybindings.overrides).toEqual({});

    button(rowOf('New note'), 'Replace').click();
    fixture.detectChanges();
    expect(settings.draft()?.keybindings.overrides).toEqual({ 'note.save': null, 'note.new': 'Mod+S' });
    expect(rowOf('Save').querySelector('.chord')?.textContent).toContain('None');
  });

  it('shows when another program holds the quick-capture hotkey', async () => {
    captureStatus = { chord: 'Mod+Alt+N', registered: false };
    fixture.destroy();
    fixture = TestBed.createComponent(SettingsShortcuts);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(rowOf('Quick capture (system-wide)').textContent).toContain('In use by another program');
  });
});
