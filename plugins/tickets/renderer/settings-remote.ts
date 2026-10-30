import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RemoteStatus } from '../main/remote/service';
import { ageOf } from '../shared/tickets';
import { el, textButton } from './settings-dom';

/**
 * Settings → Tickets → Remote access (req-66, ADR-0086): switch the
 * gateway on, choose how a phone reaches it, pair a device by QR code
 * or typed code, and revoke paired devices. Every change goes through
 * main, which restarts the gateway at once and answers with the new
 * status; the section only draws that status.
 */
export interface RemoteSection {
  readonly root: HTMLElement;
  dispose(): void;
}

export function createRemoteSection(api: DreyPluginApi): RemoteSection {
  const section = el('section', 'tset-section');
  section.setAttribute('aria-labelledby', 'tset-remote-head');
  const head = el('div', 'tset-section-head');
  const title = el('h3', undefined, 'Remote access');
  title.id = 'tset-remote-head';
  const state = el('span', 'tset-chip tset-chip-manual');
  head.append(title, state);
  const intro = el(
    'p',
    'tset-muted',
    'Use the board from a phone or tablet: move tickets, start and answer runs. Off by default; only paired devices get in.',
  );

  const rows = el('div', 'tset-kv');

  const enabled = checkbox('tset-remote-enabled');
  const reach = el('select');
  reach.id = 'tset-remote-reach';
  for (const [value, label] of [
    ['loopback', 'This computer only, through Tailscale Serve'],
    ['lan', 'Local network (plain HTTP)'],
  ] as const) {
    reach.append(Object.assign(el('option', undefined, label), { value }));
  }
  const reachHint = el('span', 'field-hint');
  const iface = el('select');
  iface.id = 'tset-remote-interface';
  const port = el('input', 'mono-input');
  port.id = 'tset-remote-port';
  port.type = 'number';
  port.min = '1024';
  port.max = '65535';
  const publicUrl = el('input', 'mono-input');
  publicUrl.id = 'tset-remote-url';
  publicUrl.type = 'url';
  publicUrl.spellcheck = false;
  const bypass = checkbox('tset-remote-bypass');

  const [ifaceLabel, ifaceValue] = kv('tset-remote-interface', 'Network interface', iface, 'The address phones on this network open.');
  rows.append(
    ...kv('tset-remote-enabled', 'Enabled', enabled, 'Starts the server now; switching off stops it.'),
    ...kvWithHint('tset-remote-reach', 'Reach', reach, reachHint),
    ifaceLabel,
    ifaceValue,
    ...kv('tset-remote-port', 'Port', port, 'Applies at once. The default is 47811.'),
    ...kv(
      'tset-remote-url',
      'Device address',
      publicUrl,
      'What the phone opens, e.g. https://desk.tail1234.ts.net. Needed for Tailscale Serve; empty uses the network address.',
    ),
    ...kv('tset-remote-bypass', 'Bypass runs', bypass, 'Let a device start runs that skip every permission prompt.'),
  );

  // Pairing
  const pairHead = el('h4', 'tset-remote-sub', 'Pair a device');
  const pairForm = el('div', 'tset-remote-pairform');
  const deviceName = el('input');
  deviceName.id = 'tset-remote-device-name';
  deviceName.type = 'text';
  deviceName.maxLength = 40;
  deviceName.setAttribute('aria-label', 'Device name');
  deviceName.title = 'Device name — the ticket Log names it (owner@<name>)';
  const readOnlyLabel = el('label', 'tset-remote-check');
  const readOnly = checkbox('tset-remote-readonly');
  readOnlyLabel.append(readOnly, document.createTextNode('Read only'));
  const pairButton = textButton('Pair', 'primary');
  pairForm.append(deviceName, readOnlyLabel, pairButton);

  const pairing = el('div', 'tset-remote-pairing');
  const qr = el('canvas', 'tset-remote-qr');
  qr.setAttribute('role', 'img');
  const pairText = el('div', 'tset-remote-pairtext');
  const pairCode = el('div', 'tset-remote-code');
  const pairUrl = el('div', 'tset-remote-url');
  const pairExpiry = el('div', 'tset-muted');
  const cancelPair = textButton('Cancel');
  pairText.append(
    el('span', undefined, 'Scan with the camera, or open the address and type the code.'),
    pairCode,
    pairUrl,
    pairExpiry,
    cancelPair,
  );
  pairing.append(qr, pairText);

  // Devices
  const devicesHead = el('h4', 'tset-remote-sub', 'Paired devices');
  const devices = el('div', 'tset-remote-devices');

  section.append(head, intro, rows, pairHead, pairForm, pairing, devicesHead, devices);

  let status: RemoteStatus | null = null;
  const render = (next: RemoteStatus): void => {
    status = next;
    const { config } = next;
    enabled.checked = config.enabled;
    reach.value = config.mode;
    reachHint.textContent =
      config.mode === 'loopback'
        ? `Run "tailscale serve --bg ${config.port}" once on this computer; the phone needs Tailscale too.`
        : 'Anyone on this network can read the traffic, including the device token.';
    reachHint.classList.toggle('tset-error', config.mode === 'lan');
    iface.replaceChildren(
      Object.assign(el('option', undefined, next.interfaces.length === 0 ? 'No network found' : 'Choose…'), { value: '' }),
      ...next.interfaces.map((i) => Object.assign(el('option', undefined, `${i.name} — ${i.address}`), { value: i.address })),
    );
    iface.value = config.lanAddress ?? '';
    ifaceLabel.hidden = config.mode !== 'lan';
    ifaceValue.hidden = config.mode !== 'lan';
    if (document.activeElement !== port) {
      port.value = String(config.port);
    }
    if (document.activeElement !== publicUrl) {
      publicUrl.value = config.publicUrl ?? '';
    }
    bypass.checked = config.allowBypass;

    if (!config.enabled) {
      state.textContent = 'Off';
      state.className = 'tset-chip tset-chip-manual';
    } else if (next.error !== null) {
      state.textContent = next.error;
      state.className = 'tset-chip tset-chip-manual tset-error';
    } else {
      state.textContent = `Listening on ${next.listening ?? '…'}`;
      state.className = 'tset-chip tset-chip-auto';
    }

    const canPair = config.enabled && next.listening !== null;
    pairHead.hidden = !canPair;
    pairForm.hidden = !canPair || next.pairing !== null;
    pairing.hidden = next.pairing === null;
    if (next.pairing !== null) {
      drawQr(qr, next.pairing.qr);
      qr.setAttribute('aria-label', `QR code for ${next.pairing.url}`);
      pairCode.textContent = `${next.pairing.code.slice(0, 5)}-${next.pairing.code.slice(5)}`;
      pairUrl.textContent = next.deviceUrl ?? '';
      const until = new Date(next.pairing.expiresAt);
      pairExpiry.textContent = `For "${next.pairing.deviceName}"${next.pairing.readOnly ? ', read only' : ''} · valid until ${until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      if (next.needsPublicUrl) {
        pairExpiry.textContent += ' · set the device address first — a phone cannot open 127.0.0.1';
      }
    }

    devicesHead.hidden = next.devices.length === 0;
    devices.replaceChildren(
      ...next.devices.map((d) => {
        const row = el('div', 'tset-remote-device');
        const name = el('span', 'tset-remote-device-name', d.name);
        const meta = el(
          'span',
          'tset-muted',
          [
            d.readOnly ? 'read only' : null,
            `paired ${new Date(d.pairedAt).toLocaleDateString()}`,
            d.lastSeen === null ? 'not seen yet' : `seen ${ageOf(d.lastSeen)} ago`,
          ]
            .filter((x): x is string => x !== null)
            .join(' · '),
        );
        const revoke = textButton('Revoke');
        revoke.title = `Revoke ${d.name}: it must pair again to get in`;
        revoke.addEventListener('click', () => void call('remoteRevoke', { id: d.id }));
        row.append(name, meta, revoke);
        return row;
      }),
    );
  };

  const call = async (method: string, payload?: unknown): Promise<void> => {
    try {
      render((await api.backend.invoke(method, payload)) as RemoteStatus);
    } catch {
      // The status stays as drawn; the next refresh corrects it.
    }
  };
  const configure = (patch: Record<string, unknown>): void => void call('remoteConfigure', patch);

  enabled.addEventListener('change', () => configure({ enabled: enabled.checked }));
  reach.addEventListener('change', () => configure({ mode: reach.value }));
  iface.addEventListener('change', () => configure({ lanAddress: iface.value === '' ? null : iface.value }));
  port.addEventListener('change', () => {
    const value = Number(port.value);
    if (Number.isInteger(value)) {
      configure({ port: value });
    }
  });
  publicUrl.addEventListener('change', () => configure({ publicUrl: publicUrl.value.trim() === '' ? null : publicUrl.value.trim() }));
  bypass.addEventListener('change', () => configure({ allowBypass: bypass.checked }));
  pairButton.addEventListener('click', () => void call('remotePair', { name: deviceName.value, readOnly: readOnly.checked }));
  cancelPair.addEventListener('click', () => void call('remotePairCancel'));

  const off = api.backend.on('remote-changed', () => void call('remoteStatus'));
  // A waiting pairing expires on its own — redraw while one shows.
  const tick = setInterval(() => {
    if (status?.pairing !== null && status?.pairing !== undefined) {
      void call('remoteStatus');
    }
  }, 15_000);
  void call('remoteStatus');

  return {
    root: section,
    dispose: () => {
      off();
      clearInterval(tick);
    },
  };
}

function checkbox(id: string): HTMLInputElement {
  const input = el('input');
  input.type = 'checkbox';
  input.id = id;
  return input;
}

function kv(id: string, label: string, control: HTMLElement, hint: string): [HTMLElement, HTMLElement] {
  return kvWithHint(id, label, control, el('span', 'field-hint', hint));
}

function kvWithHint(id: string, label: string, control: HTMLElement, hint: HTMLElement): [HTMLElement, HTMLElement] {
  const name = el('label', 'tset-kv-label', label);
  name.htmlFor = id;
  const value = el('div', 'tset-kv-value');
  value.append(control, hint);
  return [name, value];
}

/** The QR rows from main as dark squares on white, with the quiet zone. */
function drawQr(canvas: HTMLCanvasElement, rows: readonly string[]): void {
  const quiet = 4;
  const scale = 4;
  const size = (rows.length + quiet * 2) * scale;
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g === null) {
    return;
  }
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000000';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') {
        g.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
      }
    }
  });
}
