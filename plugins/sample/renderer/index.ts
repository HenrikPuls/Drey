import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';

/**
 * The sample plugin's renderer entry (ADR-0044). Plain DOM, no framework:
 * a dock widget (live active-document read + observe + insert), a command,
 * a settings page (own config + a backend roundtrip), a contributed doc
 * kind (the clock tab, ADR-0044 stage 8A), and an event log.
 */
let bufferEvents = 0;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string | null,
  styles: Partial<CSSStyleDeclaration> = {},
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== null) {
    node.textContent = text;
  }
  if (className !== undefined) {
    node.className = className;
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
  rewriteButton.addEventListener('click', () => {
    const active = api.documents.active();
    if (active === null || active.kind !== 'text') {
      return;
    }
    const after = `${active.buffer}\n\n<!-- sample-plugin rewrite proposal -->\n`;
    void api.documents.requestRewrite({
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

/**
 * Built from the shared `.plugin-settings-body` vocabulary (the base
 * PluginSettingsHost stylesheet — plugins/AUTHORING.md): a field, its
 * hint, a ghost button. No inline styles, no bespoke classes.
 */
function buildSettingsPage(api: DreyPluginApi): HTMLElement {
  const root = el('div', null, {}, 'sample-settings');

  const field = el('div', null, {}, 'field');
  const label = el('label', 'Greeting', {});
  label.setAttribute('for', 'sample-greeting');
  const input = el('input', null, {});
  input.type = 'text';
  input.id = 'sample-greeting';
  field.append(label, input);
  root.appendChild(field);
  root.appendChild(
    el('p', 'Saved immediately to this plugin’s own config (ADR-0044 rule 3).', {}, 'field-hint'),
  );

  const pingButton = el('button', 'Ping main process', {}, 'ghost');
  pingButton.type = 'button';
  root.appendChild(pingButton);

  const roundtrip = el('div', 'Backend roundtrip: —', {}, 'empty');
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
    // A plugin-contributed doc kind (ADR-0044 stage 8A): the pane body, the
    // tab-strip favicon/status slots and the session persist/restore all
    // resolve through this registration.
    let clockSeq = 0;
    api.ui.registerDocKind({
      kind: 'sample-clock',
      icon: 'sparkles',
      serialize: () => null, // stateless -- a restored clock just restarts
      restore: (path) => {
        api.documents.addDoc('sample-clock', path, 'Sample clock');
      },
      statusText: () => 'sample clock',
      mount: (host, path) => {
        const root = el('div', null, {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          flex: '1',
          gap: '8px',
          font: '13px/1.6 sans-serif',
        });
        const face = el('div', '', { fontSize: '40px', fontVariantNumeric: 'tabular-nums' });
        const sub = el('div', `tab ${path} - contributed by the sample plugin`, {
          opacity: '0.7',
        });
        root.appendChild(face);
        root.appendChild(sub);
        const tick = (): void => {
          face.textContent = new Date().toLocaleTimeString();
        };
        tick();
        const timer = window.setInterval(tick, 1000);
        host.appendChild(root);
        return () => window.clearInterval(timer);
      },
    });

    // The tab-strip entry point: a File menu row minting a fresh clock key.
    api.ui.registerMenuContributions([
      {
        menu: 'file',
        label: 'Sample: open clock tab',
        run: () => {
          api.documents.addDoc('sample-clock', `sample-clock://${++clockSeq}`, 'Sample clock');
        },
      },
    ]);

    api.ui.registerWidget({
      id: 'sample',
      title: 'Sample',
      icon: 'layers',
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
