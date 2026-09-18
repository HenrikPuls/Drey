import { TestBed } from '@angular/core/testing';
import { CalendarService } from './calendar.service';
import { SettingsService } from '../services/settings.service';
import { VaultService } from '../vault';
import { AppConfig, DreyApi, VaultFileEntry } from '../../../shared/ipc-api';

describe('CalendarService', () => {
  let service: CalendarService;
  let vault: VaultService;

  const tree: VaultFileEntry[] = [
    {
      name: 'daily',
      relativePath: 'daily',
      type: 'directory',
      children: [
        // A legacy flat file, and a note under the nested year/month layout.
        { name: '2026-09-03.md', relativePath: 'daily/2026-09-03.md', type: 'file' },
        { name: 'notes.txt', relativePath: 'daily/notes.txt', type: 'file' },
        {
          name: '2026',
          relativePath: 'daily/2026',
          type: 'directory',
          children: [
            {
              name: '09',
              relativePath: 'daily/2026/09',
              type: 'directory',
              children: [
                {
                  name: '2026-09-11.md',
                  relativePath: 'daily/2026/09/2026-09-11.md',
                  type: 'file',
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  beforeEach(() => {
    const fakeApi: Partial<DreyApi> = {
      getActiveVault: () => Promise.resolve('E:/vault'),
      getActiveVaultId: () => Promise.resolve('v1'),
      listVaults: () =>
        Promise.resolve([
          { id: 'v1', name: 'vault', path: 'E:/vault', exists: true, active: true },
        ]),
      listVaultFiles: () => Promise.resolve(tree),
    };
    window.dreyApi = fakeApi as DreyApi;
    service = TestBed.inject(CalendarService);
    vault = TestBed.inject(VaultService);
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('lays out six weeks with a Monday-first lead', () => {
    service.viewYear.set(2026);
    service.viewMonth.set(8); // September 2026, the 1st is a Tuesday
    const weeks = service.weeks();
    expect(weeks.length).toBe(6);
    expect(weeks[0].length).toBe(7);
    // Monday of that first row is Aug 31.
    expect(weeks[0][0]).toMatchObject({ dayOfMonth: 31, inMonth: false });
    expect(weeks[0][1]).toMatchObject({ dayOfMonth: 1, inMonth: true });
  });

  it('wraps the month backwards and forwards across the year boundary', () => {
    service.viewYear.set(2026);
    service.viewMonth.set(0);
    service.prevMonth();
    expect([service.viewYear(), service.viewMonth()]).toEqual([2025, 11]);
    service.nextMonth();
    expect([service.viewYear(), service.viewMonth()]).toEqual([2026, 0]);
  });

  it('marks days that have a daily note, nested or flat, ignoring non-daily files', async () => {
    await vault.refresh();
    service.viewYear.set(2026);
    service.viewMonth.set(8);
    const days = service.weeks().flat();
    expect(days.find((d) => d.iso === '2026-09-03')?.hasNote).toBe(true); // legacy flat
    expect(days.find((d) => d.iso === '2026-09-11')?.hasNote).toBe(true); // nested
    expect(days.find((d) => d.iso === '2026-09-04')?.hasNote).toBe(false);
  });

  it('marks days from the configured folder only', async () => {
    TestBed.resetTestingModule();
    const journalTree: VaultFileEntry[] = [
      // The old root is still in the tree; it must not count any more.
      ...tree,
      {
        name: 'Journal',
        relativePath: 'Journal',
        type: 'directory',
        children: [
          { name: '2026-09-04.md', relativePath: 'Journal/2026-09-04.md', type: 'file' }, // flat
          {
            name: '2026',
            relativePath: 'Journal/2026',
            type: 'directory',
            children: [
              {
                name: '09',
                relativePath: 'Journal/2026/09',
                type: 'directory',
                children: [
                  {
                    name: '2026-09-12.md',
                    relativePath: 'Journal/2026/09/2026-09-12.md',
                    type: 'file',
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    const journalApi: Partial<DreyApi> = {
      getConfig: () => Promise.resolve({ daily: { dir: 'Journal' } } as AppConfig),
      getActiveVault: () => Promise.resolve('E:/vault'),
      getActiveVaultId: () => Promise.resolve('v1'),
      listVaults: () =>
        Promise.resolve([
          { id: 'v1', name: 'vault', path: 'E:/vault', exists: true, active: true },
        ]),
      listVaultFiles: () => Promise.resolve(journalTree),
    };
    window.dreyApi = journalApi as DreyApi;
    await TestBed.inject(SettingsService).load();
    const journalService = TestBed.inject(CalendarService);
    const journalVault = TestBed.inject(VaultService);

    await journalVault.refresh();
    journalService.viewYear.set(2026);
    journalService.viewMonth.set(8);
    const days = journalService.weeks().flat();
    expect(days.find((d) => d.iso === '2026-09-04')?.hasNote).toBe(true); // Journal, flat
    expect(days.find((d) => d.iso === '2026-09-12')?.hasNote).toBe(true); // Journal, nested
    expect(days.find((d) => d.iso === '2026-09-03')?.hasNote).toBe(false); // old daily/ root
    expect(days.find((d) => d.iso === '2026-09-11')?.hasNote).toBe(false); // old daily/ root
  });

  it('select() moves the shown month to the picked day', () => {
    service.select('2026-12-24');
    expect([service.viewYear(), service.viewMonth()]).toEqual([2026, 11]);
    expect(service.selectedIso()).toBe('2026-12-24');
  });

  it('setMonth() jumps the shown month without touching the selected day', () => {
    service.select('2026-09-02');
    service.setMonth(2024, 0);
    expect([service.viewYear(), service.viewMonth()]).toEqual([2024, 0]);
    expect(service.selectedIso()).toBe('2026-09-02');
  });
});
