import { Injectable, inject } from '@angular/core';
import { OpenDocBuffer, OpenDocsReply, OpenDocsRequest } from '../../../shared/ipc-api';
import { EditorService } from './editor.service';
import { OpenDoc, docKey, isDirty } from './open-doc';

/**
 * Renderer side of the open-documents bridge (milestone 78, ADR-0071):
 * answers what the vault tools in main ask about open tabs. A tool reads
 * the buffer of an open file instead of the file on disk, and a change to
 * an open file is made to its tab — saved from there, or left unsaved for
 * a live-edit turn (ADR-0049).
 *
 * Instantiated once from `App`; the subscription lives for the app's
 * lifetime, so there is no teardown.
 */
@Injectable({ providedIn: 'root' })
export class OpenDocsBridgeService {
  private readonly editor = inject(EditorService);

  private started = false;

  start(): void {
    if (this.started || typeof window === 'undefined' || !window.dreyApi?.onOpenDocsRequest) {
      return;
    }
    this.started = true;
    window.dreyApi.onOpenDocsRequest((request) => void this.answer(request));
  }

  private async answer(request: OpenDocsRequest): Promise<void> {
    let reply: OpenDocsReply = {};
    try {
      reply = await this.handle(request);
    } catch {
      // An unanswerable request reads as "not open": the tool falls back to the file.
    } finally {
      await window.dreyApi?.replyOpenDocs?.(request.id, reply);
    }
  }

  /** Exposed for the spec; `answer` wraps it with the reply round trip. */
  async handle(request: OpenDocsRequest): Promise<OpenDocsReply> {
    switch (request.kind) {
      case 'peek': {
        const doc = this.vaultDoc(request.vaultId, request.path);
        return { buffers: doc === null ? [] : [toBuffer(doc)] };
      }
      case 'dirty':
        return {
          buffers: this.editor
            .openDocs()
            .filter((doc) => isVaultText(doc) && isDirty(doc))
            .map(toBuffer),
        };
      case 'apply': {
        const doc = this.vaultDoc(request.vaultId, request.path);
        if (doc === null) {
          return { applied: false, saved: false };
        }
        if (!request.save) {
          // One buffer change, like any other programmatic edit: unsaved,
          // and it passes a live-edit input lock.
          this.editor.updateBuffer(doc.key, request.content);
          return { applied: true, saved: false };
        }
        await this.editor.applyRewrite(doc.key, request.content, request.origin);
        const after = this.editor.docFor(doc.key);
        return { applied: true, saved: after !== null && !isDirty(after) };
      }
      case 'moved':
        this.editor.retargetTabs(
          docKey(request.vaultId, request.from),
          docKey(request.vaultId, request.to),
        );
        return {};
      case 'closed':
        this.editor.closeTabsUnder(request.vaultId, request.path);
        return {};
    }
  }

  /**
   * The open text tab of a vault file. A daily-note draft counts: the tab
   * shows its text, the assistant is handed that text, and a change saved
   * from the tab is what creates the file.
   */
  private vaultDoc(vaultId: string, path: string): OpenDoc | null {
    const doc = this.editor.docFor(docKey(vaultId, path));
    if (doc === null) {
      return null;
    }
    // An empty vault id names a tab that was never saved: its key is its name.
    return (vaultId === '' ? isUnsavedTab(doc) : isVaultText(doc)) ? doc : null;
  }
}

function isVaultText(doc: OpenDoc): boolean {
  return (
    doc.kind === 'text' &&
    doc.vaultId !== null &&
    doc.external !== true &&
    doc.help === undefined &&
    doc.askOnSave !== true
  );
}

/** A text tab that belongs to no vault and to no file elsewhere. */
function isUnsavedTab(doc: OpenDoc): boolean {
  return (
    doc.kind === 'text' && doc.vaultId === null && doc.external !== true && doc.help === undefined
  );
}

function toBuffer(doc: OpenDoc): OpenDocBuffer {
  return {
    vaultId: doc.vaultId ?? '',
    path: doc.path,
    content: doc.bufferContent,
    dirty: isDirty(doc),
  };
}
