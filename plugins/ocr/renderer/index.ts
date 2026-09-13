import type {
  DreyPluginApi,
  EditorContextMenuTarget,
  PluginRendererModule,
} from '../../../shared/plugin-api/renderer';
import {
  composeInsertedBelow,
  findImageLine,
  imageTargetFromLine,
  imageVaultPathFromUrl,
  type OcrOutcome,
} from '../shared/ocr';

/**
 * The ocr plugin's renderer entry (ADR-0050): the "Recognize text"
 * context-menu row on images (embedded in a note + the image tab), gated
 * on the ACTIVE provider's `imageAttachments` capability — the row only
 * exists while a vision-capable provider is connected. The transcription
 * itself runs main-side (`backend.invoke('ocr', …)`); this side owns the
 * progress modal (streamed partial text + Cancel, ADR-0014) and routes the
 * result: below the embed through the shared confirmation rewrite
 * (ADR-0011), or into a scratch tab for an image tab.
 *
 * Plain DOM, no framework. English everywhere (language convention).
 */

/** Synchronously-readable capability cache for the sync menu callback. */
let vision = false;

/** The clicked image, resolved for an editor surface, plus the insert point. */
interface EmbedTarget {
  readonly docPath: string;
  readonly lineNumber: number;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Resolves the menu target to an image path + insert point, or null. */
function resolveTarget(
  api: DreyPluginApi,
  target: EditorContextMenuTarget,
): { imageVaultPath: string; embed: EmbedTarget | null } | null {
  if (target.surface === 'image') {
    return { imageVaultPath: target.imagePath, embed: null };
  }
  // Editor surface: document-scoped only (the entry drawer's and plugin
  // composers' surfaces carry docPath null — no rows there).
  if (target.docPath === null) {
    return null;
  }
  // Primary signal: a widget's <img src> reverse-maps exactly, in both
  // editor modes. Fallback: the raw `![…](…)` line under the caret
  // (source mode, or a click on the revealed source container).
  const img = target.target.closest('img');
  const imageVaultPath =
    (img !== null ? imageVaultPathFromUrl(img.getAttribute('src') ?? '') : null) ??
    (target.lineText !== null ? imageTargetFromLine(target.lineText, target.docPath) : null);
  if (imageVaultPath === null) {
    return null;
  }
  // The click may map to the image but not to a document position (widget
  // DOM outside the view's mapping) — recover by scanning the live buffer
  // for the line referencing that image.
  const lineNumber =
    target.lineNumber ??
    findImageLine(api.documents.get(target.docPath)?.buffer ?? '', imageVaultPath, target.docPath);
  if (lineNumber === null) {
    return null;
  }
  return { imageVaultPath, embed: { docPath: target.docPath, lineNumber } };
}

// -- progress modal ----------------------------------------------------------

interface ModalHandle {
  appendDelta(text: string): void;
  showError(message: string): void;
  close(): void;
}

/** Small modal: streamed partial transcription, elapsed hint, Cancel. */
function openProgressModal(
  api: DreyPluginApi,
  imagePath: string,
  onCancel: () => void,
): ModalHandle {
  const root = document.createElement('div');
  root.style.cssText =
    'display:flex;flex-direction:column;gap:10px;min-width:420px;max-width:560px;' +
    'max-height:60vh;font:13px/1.5 sans-serif;color:inherit;';

  const title = document.createElement('div');
  title.textContent = 'Recognize text';
  title.style.cssText = 'font-weight:600;font-size:14px;';
  root.appendChild(title);

  const hint = document.createElement('div');
  hint.textContent = `Transcribing ${baseName(imagePath)} — a local model may take a while.`;
  hint.style.cssText = 'opacity:0.75;';
  root.appendChild(hint);

  const output = document.createElement('pre');
  output.style.cssText =
    'margin:0;padding:10px 12px;overflow:auto;flex:1;min-height:80px;white-space:pre-wrap;' +
    'word-break:break-word;border:1px solid rgba(128,128,128,.35);border-radius:8px;' +
    'font:12px/1.5 ui-monospace,monospace;';
  root.appendChild(output);

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;align-items:center;gap:10px;';
  const elapsed = document.createElement('span');
  elapsed.textContent = '0 s';
  elapsed.style.cssText = 'opacity:0.75;margin-right:auto;';
  footer.appendChild(elapsed);

  const buttonStyle =
    'cursor:pointer;padding:5px 14px;border-radius:6px;' +
    'border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font:inherit;';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.textContent = 'Cancel';
  cancelButton.style.cssText = buttonStyle;
  footer.appendChild(cancelButton);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = 'Close';
  closeButton.style.cssText = buttonStyle;
  closeButton.style.display = 'none';
  footer.appendChild(closeButton);
  root.appendChild(footer);

  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    elapsed.textContent = `${seconds} s`;
  }, 1000);

  const close = api.ui.showModal((el) => el.appendChild(root));
  const finish = (): void => {
    window.clearInterval(timer);
  };

  cancelButton.addEventListener('click', () => {
    onCancel();
  });
  closeButton.addEventListener('click', () => {
    finish();
    close();
  });

  return {
    appendDelta(text) {
      output.textContent += text;
      output.scrollTop = output.scrollHeight;
    },
    showError(message) {
      finish();
      cancelButton.style.display = 'none';
      closeButton.style.display = '';
      const error = document.createElement('div');
      error.textContent = message;
      error.style.cssText = 'color:#e0705c;white-space:pre-wrap;';
      root.insertBefore(error, footer);
    },
    close() {
      finish();
      close();
    },
  };
}

// -- the OCR flow ------------------------------------------------------------

async function runOcrFlow(
  api: DreyPluginApi,
  imageVaultPath: string,
  embed: EmbedTarget | null,
): Promise<void> {
  const taskId = crypto.randomUUID();
  const modal = openProgressModal(api, imageVaultPath, () => {
    void api.llm.cancelTask(taskId);
  });

  const unsubscribe = api.backend.on('ocr:delta', (data) => {
    const shape = (data ?? {}) as { taskId?: unknown; text?: unknown };
    if (shape.taskId === taskId && typeof shape.text === 'string') {
      modal.appendDelta(shape.text);
    }
  });

  let outcome: OcrOutcome;
  try {
    outcome = (await api.backend.invoke('ocr', { imageVaultPath, taskId })) as OcrOutcome;
  } catch (err) {
    unsubscribe();
    modal.showError(err instanceof Error ? err.message : String(err));
    return; // the modal stays up with the error + Close
  }
  unsubscribe();
  modal.close();

  if (outcome.kind !== 'ok' || outcome.text === '') {
    return; // cancelled (or an empty transcription) — quiet close
  }
  if (embed === null) {
    // Image tab: the result becomes an unsaved scratch tab next to the
    // image's name (the tags plugin's search-export pattern). The image
    // extension stays in the name so a real note never collides.
    api.documents.openScratch(`${baseName(imageVaultPath)}.md`, outcome.text);
    return;
  }

  // Embedded image: splice below the embed line through the shared
  // confirmation dialog (ADR-0011); the host's applyRewrite saves on
  // confirm. Live buffer first — the disk copy may be staler.
  const doc = api.documents.get(embed.docPath);
  let before = doc?.buffer ?? null;
  if (before === null) {
    try {
      before = (await api.vault.readFile(embed.docPath)).content;
    } catch {
      return; // the note vanished while we were transcribing
    }
  }
  await api.documents.requestRewrite({
    path: embed.docPath,
    before,
    after: composeInsertedBelow(before, embed.lineNumber, outcome.text),
    title: 'Recognize text',
    summary: `Text recognized in ${baseName(imageVaultPath)}`,
    previewStyle: 'localized',
  });
}

// -- activation --------------------------------------------------------------

const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    // Seed the capability cache, then keep it fresh via the config-write
    // push — a provider switch flips the row without an app restart.
    void api.llm
      .capabilities()
      .then((caps) => {
        vision = caps.imageAttachments;
      })
      .catch(() => {
        vision = false; // unrouted provider id — no rows until it is fixed
      });
    api.llm.onCapabilitiesChanged((caps) => {
      vision = caps.imageAttachments;
    });

    api.editor.registerContextMenuItems((target) => {
      const resolved = resolveTarget(api, target);
      if (resolved === null) {
        return []; // not an image — no row (an absent plugin contributes nothing either way)
      }
      // The row shows on every resolvable image: ENABLED when the active
      // provider can actually read images, GRAYED when the LLM switch is
      // off or the provider lacks the imageAttachments capability — so the
      // feature stays discoverable and the missing prerequisite is visible.
      const ready = api.llm.enabled() && vision;
      return [
        {
          label: 'Recognize text',
          ...(ready ? {} : { disabled: true as const }),
          run: () => {
            if (ready) {
              void runOcrFlow(api, resolved.imageVaultPath, resolved.embed);
            }
          },
        },
      ];
    });
  },
};

export default plugin;
