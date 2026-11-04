// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RemoteStatus } from '../../../packages/tickets-engine/src/server/service';
import { createRemoteSection } from './settings-remote';

const NOW = Date.now();
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function statusOf(devices: RemoteStatus['devices']): RemoteStatus {
  return {
    config: { enabled: true, mode: 'loopback', lanAddress: null, port: 47811, publicUrl: null, allowBypass: false },
    listening: '127.0.0.1:47811',
    error: null,
    deviceUrl: 'http://127.0.0.1:47811',
    needsPublicUrl: false,
    devices,
    pairing: null,
    interfaces: [],
  } as RemoteStatus;
}

async function mount(devices: RemoteStatus['devices']): Promise<HTMLElement> {
  const api = {
    backend: { invoke: vi.fn(async () => statusOf(devices)), on: vi.fn(() => () => undefined) },
  } as unknown as DreyPluginApi;
  const section = createRemoteSection(api);
  await vi.waitFor(() => expect(section.root.querySelector('.tset-remote-sub:last-of-type')?.textContent).not.toBe(''));
  section.dispose();
  return section.root;
}

describe('Settings → Remote access → paired devices (D-2)', () => {
  it("lists the owner's four devices with total, suffix for the doubled name and the Inactive marker", async () => {
    const root = await mount([
      { id: 'b2c3d4e5', name: 'Phone', readOnly: false, pairedAt: ago(40 * 86_400_000), lastSeen: ago(30 * 86_400_000) },
      { id: 'f6a7b8c9', name: 'Phone', readOnly: false, pairedAt: ago(86_400_000), lastSeen: ago(3 * 3_600_000) },
      { id: '1234abcd', name: 'iPad', readOnly: true, pairedAt: ago(10 * 86_400_000), lastSeen: ago(5 * 60_000) },
      { id: '9999ffff', name: 'Claude', readOnly: false, pairedAt: ago(2 * 3_600_000), lastSeen: null },
    ]);
    const heading = Array.from(root.querySelectorAll('h4')).find((h) => h.textContent?.includes('paired'));
    expect(heading?.textContent).toBe('4 paired devices');
    const rows = Array.from(root.querySelectorAll('.tset-remote-device'));
    expect(rows.map((r) => r.querySelector('.tset-remote-device-name')?.textContent)).toEqual([
      'iPad',
      'Claude',
      'Phone · f6a7',
      'Phone · b2c3',
    ]);
    expect(rows[0]!.textContent).toContain('Read-only');
    expect(rows[1]!.textContent).toContain('not connected yet');
    expect(rows[2]!.textContent).toContain('3 h ago');
    expect(rows[3]!.textContent).toContain('Inactive');
    expect(rows[3]!.textContent).toContain('Last connected');
    expect(rows[3]!.textContent).toContain('30 d ago');
  });

  it('says so when nothing is paired', async () => {
    const root = await mount([]);
    expect(Array.from(root.querySelectorAll('h4')).map((h) => h.textContent)).toContain('No paired devices');
  });
});
