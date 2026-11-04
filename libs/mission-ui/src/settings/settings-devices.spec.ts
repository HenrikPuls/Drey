import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Settings } from './settings';
import {
  MC_SETTINGS_STATE,
  countdownOf,
  groupedCode,
  parsePairingView,
  qrPathOf,
  type McPairingView,
  type McSettingsState,
  type McSettingsView,
} from './settings.model';
import { deviceListOf } from './device-list';
import { deviceListOf as engineDeviceListOf } from '../../../../packages/tickets-engine/src/contracts/device-list';
import { CASE_FORMAT, DEVICE_LIST_CASES } from '../../../../packages/tickets-engine/src/contracts/device-list.cases';
import { Theme, THEME_ENV } from '../theme';

const NOW_ISO = new Date().toISOString();
const OLD = '2026-01-01T00:00:00Z';

const VIEW: McSettingsView = {
  chat: null,
  devices: [
    { id: 'd1aa', name: 'Phone', readOnly: false, pairedAt: '2026-11-01T10:00:00Z', lastSeen: NOW_ISO, current: true },
    { id: 'd2bb', name: 'Tablet', readOnly: true, pairedAt: OLD, lastSeen: OLD, current: false },
  ],
  videos: { inGit: false, limitMb: 2000, existing: 0, notice: null },
};

const WAITING: McPairingView = {
  needsPublicUrl: false,
  pairing: {
    code: 'ABCDE12345',
    url: 'https://desk.test/#pair=ABCDE12345',
    deviceName: 'Pia phone',
    readOnly: false,
    expiresAt: new Date(Date.now() + 4 * 60_000 + 30_000).toISOString(),
    qr: ['101', '010', '101'],
  },
};

function mount(view: McSettingsView, pairing?: McPairingView | null) {
  const fake = {
    settings: signal<McSettingsView | null>(view),
    settingsError: signal<string | null>(null),
    load: vi.fn(() => Promise.resolve()),
    setVideoLimit: vi.fn(() => Promise.resolve({ ok: true as const })),
    setVideosInGit: vi.fn(() => Promise.resolve({ ok: true as const })),
    revokeDevice: vi.fn(() => Promise.resolve({ ok: true as const })),
    ...(pairing === undefined
      ? {}
      : {
          pairingView: signal<McPairingView | null>(pairing),
          startPairing: vi.fn((_name: string, _readOnly: boolean) => Promise.resolve({ ok: true as const })),
          cancelPairing: vi.fn(() => Promise.resolve({ ok: true as const })),
          refreshPairing: vi.fn(() => Promise.resolve()),
        }),
  };
  const storage = new Map<string, string>();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MC_SETTINGS_STATE, useValue: fake as unknown as McSettingsState },
      {
        provide: THEME_ENV,
        useValue: {
          doc: null,
          storage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) } as unknown as Storage,
        },
      },
    ],
  });
  TestBed.inject(Theme);
  const fixture = TestBed.createComponent(Settings);
  fixture.detectChanges();
  const vm = fixture.componentInstance as unknown as { open(page: string): void; tick(): void };
  vm.open('devices');
  fixture.detectChanges();
  return { fake, fixture, el: fixture.nativeElement as HTMLElement, vm };
}

const click = (el: Element | null): void => (el as HTMLElement).click();
const buttonWith = (el: HTMLElement, text: string): Element | null =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null;

describe('the device list (D-2)', () => {
  it('runs the engine contract and the local copy on the same cases', () => {
    for (const c of DEVICE_LIST_CASES) {
      const local = deviceListOf(c.devices, c.now, CASE_FORMAT);
      expect(local).toEqual(engineDeviceListOf(c.devices, c.now, CASE_FORMAT));
      expect(local.rows.map((r) => [r.id, r.label, r.line, r.current, r.inactive])).toEqual(c.rows);
    }
  });

  it('shows the total, one row per device, This device and Inactive markers', () => {
    const { el } = mount({
      ...VIEW,
      devices: [VIEW.devices[0]!, { ...VIEW.devices[1]!, name: 'Phone' }],
    });
    expect(el.querySelector('.page-body .cap')?.textContent?.trim()).toBe('2 paired devices');
    const rows = Array.from(el.querySelectorAll('.dev'));
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Phone · d1aa');
    expect(rows[0]!.textContent).toContain('This device');
    expect(rows[0]!.textContent).toContain('Last connected');
    expect(rows[0]!.textContent).toContain('just now');
    expect(rows[1]!.textContent).toContain('Phone · d2bb');
    expect(rows[1]!.textContent).toContain('Inactive');
    expect(rows[1]!.textContent).toContain('Read-only');
  });

  it('states singular and none', () => {
    expect(mount({ ...VIEW, devices: [VIEW.devices[0]!] }).el.querySelector('.page-body .cap')?.textContent?.trim()).toBe('1 paired device');
    expect(mount({ ...VIEW, devices: [] }).el.querySelector('.page-body .cap')?.textContent?.trim()).toBe('No paired devices');
  });
});

describe('pairing from Mission Control (D-2)', () => {
  it('shows the form on a full device and starts a pairing with name and read-only', () => {
    const { el, fake, fixture } = mount(VIEW, null);
    expect(el.textContent).toContain('Pair another device');
    const name = el.querySelector<HTMLInputElement>('input.txt')!;
    name.value = 'Pia phone';
    name.dispatchEvent(new Event('input'));
    const sw = el.querySelectorAll<HTMLInputElement>('.page-body input[role="switch"]')[0]!;
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    click(buttonWith(el, 'Show pairing code'));
    expect(fake.startPairing).toHaveBeenCalledWith('Pia phone', true);
  });

  it('shows no pairing on a read-only device, or on a client without the capability', () => {
    const viewer: McSettingsView = { ...VIEW, devices: [{ ...VIEW.devices[0]!, readOnly: true }, VIEW.devices[1]!] };
    expect(mount(viewer, null).el.textContent).not.toContain('Pair another device');
    expect(mount(VIEW).el.textContent).not.toContain('Pair another device');
  });

  it('draws code, QR, link and countdown, and cancels', () => {
    const { el, fake, vm, fixture } = mount(VIEW, WAITING);
    vm.tick();
    fixture.detectChanges();
    expect(el.querySelector('.code')?.textContent).toBe('ABCDE-12345');
    expect(el.querySelector('.link')?.textContent).toContain('#pair=ABCDE12345');
    expect(el.querySelector('svg.qr path')?.getAttribute('d')).toContain('M4 4h1v1h-1z');
    expect(el.querySelector('.pairing .note')?.textContent).toMatch(/expires in 4:[23]\d/);
    expect(el.textContent).not.toContain('Set the device address first');
    click(buttonWith(el, 'Cancel'));
    expect(fake.cancelPairing).toHaveBeenCalledTimes(1);
  });

  it('gives the desktop hint when the device address is missing', () => {
    const { el } = mount(VIEW, { ...WAITING, needsPublicUrl: true });
    expect(el.querySelector('.pairing .inline-error')?.textContent).toContain('Set the device address first');
  });

  it('asks the engine every third second while a pairing waits', () => {
    const { fake, vm } = mount(VIEW, WAITING);
    const before = fake.refreshPairing!.mock.calls.length;
    vm.tick();
    vm.tick();
    expect(fake.refreshPairing!.mock.calls.length).toBe(before);
    vm.tick();
    expect(fake.refreshPairing!.mock.calls.length).toBe(before + 1);
  });
});

describe('pairing helpers', () => {
  it('groups the code, counts down and builds the QR path', () => {
    expect(groupedCode('ABCDE12345')).toBe('ABCDE-12345');
    expect(countdownOf('2026-11-04T10:05:00Z', Date.parse('2026-11-04T10:00:28Z'))).toBe('4:32');
    expect(countdownOf('2026-11-04T10:05:00Z', Date.parse('2026-11-04T10:06:00Z'))).toBe('0:00');
    expect(qrPathOf(['10', '01'])).toEqual({ d: 'M4 4h1v1h-1zM5 5h1v1h-1z', size: 10 });
  });

  it('reads the pairing answer tolerantly', () => {
    expect(parsePairingView({ ok: true, pairing: null, needsPublicUrl: true })).toEqual({ pairing: null, needsPublicUrl: true });
    expect(parsePairingView({ ok: true, pairing: { code: 'A' } })).toBeNull();
    expect(parsePairingView({ ok: false })).toBeNull();
    expect(parsePairingView({ ok: true, pairing: WAITING.pairing })?.pairing?.code).toBe('ABCDE12345');
  });
});
