import type {
  ContextMenuItem,
  DreyPluginApi,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import {
  DIAGRAM_SUFFIXES,
  baseName,
  diagramCandidatesInLine,
  diagramFormatOf,
  diagramFromAssetUrl,
  diagramXmlOf,
  docKeyFor,
  emptyDiagram,
  isPictureDiagram,
  newDiagramTarget,
  parseDocKey,
  pictureFormat,
  pictureWithDiagram,
  type DiagramRef,
  type PictureFormat,
} from './diagram-file.js';
import { EmbedSession, editorFrameUrl } from './embed-session.js';
import { diagramSlashExtension } from './slash.js';

/**
 * The diagrams plugin (ADR-0064): `.drawio.svg` / `.drawio.png` /
 * `.drawio` files open in a tab holding the bundled draw.io editor (an
 * iframe over `plugin://drawio/webapp/`, offline), saved automatically.
 * The two picture formats are ordinary pictures to the rest of the app, so
 * embedding one in a note is the existing image embed; this plugin adds
 * the ways in -- the file opener, "Edit diagram" on an embedded picture,
 * "Insert diagram" (context menu, formatting bar, `/diagram`) and "New
 * diagram" -- and the setting for which picture format a new diagram gets.
 */

const KIND = 'drawio';
const WEBAPP_ROOT = 'plugin://drawio/webapp';
/** The plugin's own setting: the picture format of a new diagram. */
const FORMAT_SETTING = 'newDiagramFormat';

/** Whether the app currently wears a dark theme (its main surface is dark). */
function appIsDark(): boolean {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--bg-main').trim();
  const probe = document.createElement('span');
  probe.style.color = color;
  document.body.append(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
  probe.remove();
  if (rgb === null || rgb.length < 3) {
    return true;
  }
  const [r, g, b] = rgb.map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

function vaultOpts(ref: DiagramRef): { vaultId: string } | undefined {
  return ref.vaultId === null ? undefined : { vaultId: ref.vaultId };
}

function mountDiagramTab(api: DreyPluginApi, el: HTMLElement, key: string): () => void {
  const root = document.createElement('div');
  root.className = 'drawio-tab';
  const notice = document.createElement('div');
  notice.className = 'drawio-notice';
  notice.textContent = 'Loading diagram…';
  root.append(notice);
  el.append(root);

  const ref = parseDocKey(key);
  const format = ref === null ? null : diagramFormatOf(ref.path);
  let session: EmbedSession | null = null;
  let frame: HTMLIFrameElement | null = null;
  let disposed = false;
  const cleanups: (() => void)[] = [];

  const fail = (message: string): void => {
    session?.abandon();
    frame?.remove();
    frame = null;
    notice.textContent = message;
    notice.hidden = false;
  };

  const start = async (): Promise<void> => {
    if (ref === null || format === null) {
      fail('This tab does not point at a diagram file.');
      return;
    }
    // The editor is a separate download (`npm run fetch:drawio`); a build
    // without it says so instead of showing an empty frame.
    const probe = await fetch(`${WEBAPP_ROOT}/index.html`, { method: 'HEAD' }).catch(() => null);
    if (disposed) {
      return;
    }
    if (probe === null || !probe.ok) {
      fail('The diagram editor is not part of this build. Run "npm run fetch:drawio" and rebuild.');
      return;
    }
    let content: string | Uint8Array;
    try {
      content =
        format === 'png'
          ? await api.vault.readBinary(ref.path, vaultOpts(ref))
          : (await api.vault.readFile(ref.path, vaultOpts(ref))).content;
    } catch {
      if (!disposed) {
        fail(`Diagram not found: ${ref.path}`);
      }
      return;
    }
    if (disposed) {
      return;
    }
    const xml = diagramXmlOf(format, content);
    if (xml === null) {
      fail('This picture holds no draw.io diagram, so it cannot be edited here.');
      return;
    }

    const view = document.createElement('iframe');
    view.className = 'drawio-frame';
    view.title = 'Diagram editor';
    frame = view;
    session = new EmbedSession(
      { format, xml, original: content, withDiagram: pictureWithDiagram },
      {
        post: (message) => view.contentWindow?.postMessage(JSON.stringify(message), '*'),
        // Announced: pictures of this diagram in open notes follow the save.
        write: async (saved) => {
          const opts = { ...vaultOpts(ref), announce: true };
          if (typeof saved === 'string') {
            await api.vault.writeFile(ref.path, saved, opts);
          } else {
            await api.vault.writeBinary(ref.path, saved, opts);
          }
        },
        setTimer: (run, ms) => window.setTimeout(run, ms),
        clearTimer: (handle) => window.clearTimeout(handle as number),
        onError: (message) => {
          notice.textContent = `Could not save the diagram: ${message}`;
          notice.hidden = false;
          notice.classList.add('drawio-notice-bar');
        },
      },
    );
    const current = session;
    const onMessage = (event: MessageEvent): void => {
      // Only this tab's own frame speaks to this session.
      if (event.source !== view.contentWindow) {
        return;
      }
      current.handle(event.data);
      if (current.isLoaded && !notice.classList.contains('drawio-notice-bar')) {
        notice.hidden = true;
      }
    };
    window.addEventListener('message', onMessage);
    cleanups.push(() => window.removeEventListener('message', onMessage));

    // The file went away (deleted, renamed, moved) -- stop writing to the
    // old path rather than recreating it.
    cleanups.push(
      api.vault.onChanged(() => {
        void api.vault.readFile(ref.path, vaultOpts(ref)).catch(() => {
          if (!disposed) {
            fail(`Diagram not found: ${ref.path}`);
          }
        });
      }),
    );

    view.src = editorFrameUrl(WEBAPP_ROOT, appIsDark());
    root.append(view);
  };

  void start();

  return () => {
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
    // Pending content is written without the frame (see `EmbedSession`).
    void session?.dispose();
    root.remove();
  };
}

const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    const openDiagram = (ref: DiagramRef): void =>
      api.documents.addDoc(KIND, docKeyFor(ref), baseName(ref.path));

    api.ui.registerDocKind({
      kind: KIND,
      icon: 'shapes',
      // The key is the whole state: vault + path.
      serialize: () => null,
      restore: (key) => {
        const ref = parseDocKey(key);
        if (ref !== null) {
          openDiagram(ref);
        }
      },
      statusText: (key) => parseDocKey(key)?.path ?? null,
      mount: (el, key) => mountDiagramTab(api, el, key),
    });

    api.documents.registerFileOpener({
      extensions: DIAGRAM_SUFFIXES,
      open: (path, vaultId) => openDiagram({ path, vaultId }),
    });

    /** The note a new diagram belongs to: the focused text document of a vault. */
    const activeNote = (): { path: string; vaultId: string | null } | null => {
      const doc = api.documents.active();
      if (doc === null || doc.kind !== 'text' || doc.path.includes('://')) {
        return null;
      }
      return { path: doc.path, vaultId: doc.vaultId };
    };

    const newFormat = async (): Promise<PictureFormat> =>
      pictureFormat(await api.settings.get<string>(FORMAT_SETTING).catch(() => undefined));

    /**
     * The caret insert reaches the editor on its next render; the diagram
     * tab must not take the editor's place before it landed.
     */
    const insertAtCaret = async (path: string, markdown: string): Promise<void> => {
      if (!api.documents.insertAtCursor(markdown)) {
        return;
      }
      for (let frame = 0; frame < 30; frame++) {
        if (api.documents.get(path)?.buffer.includes(markdown) === true) {
          return;
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    };

    /**
     * Creates a blank diagram beside the focused note (the vault root's
     * `attachments/` without one), embeds it, then opens its editor tab --
     * in that order, because the tab may replace the note's editor.
     * `embed`: `'caret'` inserts at the caret, a function receives the
     * Markdown and places it itself (the slash menu replaces the typed
     * text), `null` creates the file only.
     */
    const createDiagram = async (
      embed: 'caret' | ((markdown: string) => void) | null,
    ): Promise<void> => {
      const note = activeNote();
      const format = await newFormat();
      const target = newDiagramTarget(note?.path ?? null, new Date(), format);
      const ref: DiagramRef = { path: target.path, vaultId: note?.vaultId ?? null };
      const opts = { ...vaultOpts(ref), announce: true };
      try {
        const blank = await emptyDiagram(format);
        if (typeof blank === 'string') {
          await api.vault.writeFile(ref.path, blank, opts);
        } else {
          await api.vault.writeBinary(ref.path, blank, opts);
        }
      } catch (error) {
        await api.ui.showMessage(
          `Could not create the diagram: ${error instanceof Error ? error.message : String(error)}`,
          'New diagram',
        );
        return;
      }
      const markdown = `![diagram](${target.reference})`;
      if (note !== null && embed === 'caret') {
        await insertAtCaret(note.path, markdown);
      } else if (note !== null && typeof embed === 'function') {
        embed(markdown);
      }
      openDiagram(ref);
    };

    api.commands.register({
      id: 'drawio.new',
      label: 'New diagram',
      run: () => void createDiagram(null),
    });
    api.ui.registerMenuContributions([
      { menu: 'file', label: 'New diagram', commandId: 'drawio.new' },
    ]);

    // The formatting bar's button and the slash menu's entry.
    api.editor.registerToolbarButtons([
      { icon: 'shapes', title: 'Insert diagram', run: () => void createDiagram('caret') },
    ]);
    api.editor.registerExtension('document', () =>
      diagramSlashExtension(api, (place) => createDiagram(place)),
    );

    /** Opens the first candidate that exists (note-relative before vault-root). */
    const openFirstExisting = async (
      candidates: readonly string[],
      vaultId: string | null,
    ): Promise<void> => {
      const files = await api.vault
        .listFiles(vaultId === null ? undefined : { vaultId })
        .catch(() => []);
      const known = new Set<string>();
      const walk = (entries: readonly { relativePath: string; children?: unknown }[]): void => {
        for (const entry of entries) {
          known.add(entry.relativePath);
          if (Array.isArray(entry.children)) {
            walk(entry.children as { relativePath: string; children?: unknown }[]);
          }
        }
      };
      walk(files);
      const path = candidates.find((candidate) => known.has(candidate)) ?? candidates[0];
      openDiagram({ path, vaultId });
    };

    api.editor.registerContextMenuItems((target) => {
      const items: ContextMenuItem[] = [];
      if (target.surface === 'image') {
        if (isPictureDiagram(target.imagePath)) {
          items.push({
            label: 'Edit diagram',
            run: () => openDiagram({ path: target.imagePath, vaultId: null }),
          });
        }
        return items;
      }
      // The click may land on the picture's chrome (the resize grip covers
      // a small picture entirely), so look from the embed, not the node.
      const image =
        target.target instanceof HTMLImageElement
          ? target.target
          : (target.target.closest('.lp-image') ?? target.target).querySelector('img');
      const embedded = image === null ? null : diagramFromAssetUrl(image.src);
      if (embedded !== null) {
        items.push({ label: 'Edit diagram', run: () => openDiagram(embedded) });
      } else if (target.docPath !== null && target.lineText !== null) {
        // Not on the picture itself -- its revealed source, or the box
        // around a very small picture: take the diagram from the line.
        const candidates = diagramCandidatesInLine(target.lineText, target.docPath);
        if (candidates.length > 0) {
          const vaultId = api.documents.get(target.docPath)?.vaultId ?? null;
          items.push({
            label: 'Edit diagram',
            run: () => void openFirstExisting(candidates, vaultId),
          });
        }
      }
      if (target.docPath !== null) {
        items.push({ label: 'Insert diagram', run: () => void createDiagram('caret') });
      }
      return items;
    });

    api.ui.registerSettingsPage({
      id: 'drawio',
      label: 'Diagrams',
      hint: 'Format of new diagrams',
      description: 'How draw.io diagrams created in a note are stored.',
      mount: (body) => {
        const field = document.createElement('div');
        field.className = 'field';
        const label = document.createElement('label');
        label.htmlFor = 'drawio-new-format';
        label.textContent = 'Format of new diagrams';
        const select = document.createElement('select');
        select.id = 'drawio-new-format';
        select.className = 'narrow';
        for (const [value, text] of [
          ['svg', 'SVG (.drawio.svg)'],
          ['png', 'PNG (.drawio.png)'],
        ] as const) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          select.append(option);
        }
        const hint = document.createElement('p');
        hint.className = 'field-hint';
        hint.textContent =
          'Both are pictures that carry the diagram, so a note embeds them like any image. ' +
          'SVG stays sharp at every size and is text; PNG shows in programs that cannot display SVG. ' +
          'Existing diagrams keep their format.';
        field.append(label, select, hint);
        body.append(field);
        void newFormat().then((format) => (select.value = format));
        select.addEventListener('change', () => {
          void api.settings.set(FORMAT_SETTING, pictureFormat(select.value));
        });
        return () => field.remove();
      },
    });
  },
};

export default plugin;
