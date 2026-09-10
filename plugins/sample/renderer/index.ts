import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';

/**
 * The sample plugin's renderer entry (ADR-0044). Plain DOM, no framework:
 * a dock widget (live active-document read + observe + insert), a command,
 * a settings page (own config + a backend roundtrip), and an event log.
 */
let bufferEvents = 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string | null,
  styles: Partial<CSSStyleDeclaration>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== null) {
    node.textContent = text;
  }
  Object.assign(node.style, styles);
  return node;
}

function buildWidget(api: DreyPluginApi): HTMLElement {
  const root = el('div', null, { padding: '10px 12px', font: '12px/1.5 sans-serif' });

  const title = el('div', 'Sample plugin', {
    fontWeight: '600',
    marginBottom: '6px',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    fontSize: '10px',
    opacity: '0.7',
  });
  root.appendChild(title);

  const docLine = el('div', 'No document open', { opacity: '0.75', marginBottom: '4px' });
  const countLine = el('div', 'buffer events: 0', { opacity: '0.75', marginBottom: '8px' });
  root.appendChild(docLine);
  root.appendChild(countLine);

  const insertButton = el('button', 'Insert timestamp', {
    cursor: 'pointer',
    padding: '3px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,.4)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    marginRight: '6px',
  });
  insertButton.addEventListener('click', () => {
    const stamp = new Date().toLocaleTimeString();
    api.documents.insertAtCursor(`\n${stamp} — inserted by the sample plugin\n`);
  });
  root.appendChild(insertButton);

  const rewriteButton = el('button', 'Propose rewrite', {
    cursor: 'pointer',
    padding: '3px 10px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,.4)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  });
  rewriteButton.addEventListener('click', async () => {
    const active = api.documents.active();
    if (active === null || active.kind !== 'text') {
      return;
    }
    const after = `${active.buffer}\n\n<!-- sample-plugin rewrite proposal -->\n`;
    await api.documents.requestRewrite({
      path: active.path,
      before: active.buffer,
      after,
      title: 'Sample plugin rewrite',
      summary: 'Appends a comment line',
      previewStyle: 'localized',
    });
  });
  root.appendChild(rewriteButton);

  const refresh = (): void => {
    const active = api.documents.active();
    docLine.textContent = active === null ? 'No document open' : `active: ${active.path}`;
    if (active !== null) {
      docLine.textContent += ` (${active.buffer.length} chars${active.dirty ? ', unsaved' : ''})`;
    }
  };
  refresh();
  api.documents.onChange((event) => {
    if (event.type === 'buffer-changed') {
      bufferEvents++;
      countLine.textContent = `buffer events: ${bufferEvents}`;
    }
    refresh();
  });

  return root;
}

function buildSettingsPage(api: DreyPluginApi): HTMLElement {
  const root = el('div', null, {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxWidth: '420px',
    font: '13px/1.5 sans-serif',
  });
  const label = el('label', 'Greeting (saved immediately, per-plugin config)', {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  });
  const input = el('input', null, {
    padding: '6px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,.4)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
  });
  label.appendChild(input);
  root.appendChild(label);

  const roundtrip = el('div', 'Backend roundtrip: —', { opacity: '0.75' });
  const pingButton = el('button', 'Ping main process', {
    cursor: 'pointer',
    padding: '5px 12px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,.4)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    alignSelf: 'flex-start',
  });
  root.appendChild(pingButton);
  root.appendChild(roundtrip);

  let greeting = '';
  void api.settings.get<string>('greeting').then((saved) => {
    greeting = saved ?? 'Hello from the sample plugin!';
    input.value = greeting;
  });
  input.addEventListener('input', () => {
    greeting = input.value;
    void api.settings.set('greeting', greeting);
  });
  pingButton.addEventListener('click', () => {
    void api.backend.invoke('ping', greeting).then((reply) => {
      roundtrip.textContent = `Backend roundtrip: ${JSON.stringify(reply)}`;
    });
  });
  api.backend.on('pong', () => {
    /* the invoke's promise already carries the reply; the push proves events flow */
  });

  return root;
}

const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    api.ui.registerWidget({
      id: 'sample',
      title: 'Sample',
      defaultDock: 'right',
      defaultOpen: true,
      defaultFlex: 140,
      status: () => `evt ${bufferEvents}`,
      mount: (body) => {
        body.appendChild(buildWidget(api));
        return () => undefined;
      },
    });

    api.ui.registerSettingsPage({
      id: 'sample',
      label: 'Sample plugin',
      hint: 'Roundtrip & config',
      mount: (body) => {
        body.appendChild(buildSettingsPage(api));
        return () => undefined;
      },
    });

    api.commands.register({
      id: 'sample.stamp',
      label: 'Sample: insert timestamp',
      keybinding: 'Mod+Alt+J',
      run: () => {
        api.documents.insertAtCursor(`\n${new Date().toISOString()} — sample command\n`);
      },
    });
  },
};

export default plugin;
