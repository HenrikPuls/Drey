import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';

/**
 * The Meeting plugin's renderer entry: claims `.ics` / `.msg` drops ahead of
 * the base cascade and contributes the "File → Import meeting …" row. Both
 * talk to the plugin's main entry over `backend.invoke('decode' | 'import')`
 * and insert the returned section at the caret.
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    const isInvite = (name: string): boolean => /\.(ics|msg)$/i.test(name);

    const droppedInvite = (data: DataTransfer): File | undefined => {
      for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== 'file') {
          continue;
        }
        const file = item.getAsFile();
        if (file && isInvite(file.name)) {
          return file;
        }
      }
      return Array.from(data.files ?? []).find((f) => isInvite(f.name));
    };

    const decodeFile = async (file: File): Promise<string> => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return (await api.backend.invoke('decode', { bytes, filename: file.name })) as string;
    };

    const insert = (markdown: string): void => {
      if (!api.documents.insertAtCursor(markdown)) {
        void api.ui.showMessage('Open a note before importing a meeting.');
      }
    };

    api.editor.registerDropDecoder({
      match: (data) => droppedInvite(data) !== undefined,
      decode: async (data) => {
        const file = droppedInvite(data);
        if (file === undefined) {
          throw new Error('That file is not a recognised calendar invite.');
        }
        return await decodeFile(file);
      },
    });

    api.ui.registerMenuContributions([
      {
        menu: 'file',
        label: 'Import meeting …',
        run: () => {
          if (api.documents.active() === null) {
            void api.ui.showMessage('Open a note before importing a meeting.');
            return;
          }
          void api.backend
            .invoke('import')
            .then((block) => {
              if (typeof block === 'string') {
                insert(block);
              }
            })
            .catch((error: unknown) => api.ui.showMessage(String(error), 'Import meeting failed'));
        },
      },
    ]);
  },
};

export default plugin;
