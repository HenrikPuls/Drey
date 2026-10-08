import { readFile } from 'node:fs/promises';
import type {
  ChatAttachment,
  MainPluginContext,
  MainPluginModule,
} from '../../../shared/plugin-api';
import {
  IMAGE_MEDIA_TYPES,
  parseOcrPayload,
  stripOuterFence,
  type OcrOutcome,
} from '../shared/ocr';
import { OCR_SYSTEM, OCR_USER } from '../shared/ocr-prompt';

/**
 * The ocr plugin's main entry (ADR-0050): one backend method, `ocr`, that
 * resolves a vault image, base64s it, and asks the ACTIVE provider to
 * transcribe it (`ctx.llm.chat` with `attachments` — the renderer-side LLM
 * facade cannot carry images, so this side owns the call).
 *
 * Cancellation rides the base `LlmTaskRegistry`: `taskId` is minted in the
 * renderer and Cancel calls `api.llm.cancelTask(taskId)`, which aborts the
 * in-flight chat here (ADR-0014: no timeout, the user decides).
 *
 * NOTE: never name the top-level export `module` — shadowing the CJS
 * `module` binding makes Node's module detection load the compiled file as
 * a broken ES module (the e2e suite caught exactly that).
 */

/** `electron/llm` is not importable from a plugin — the local copy. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** One OCR run; throws user-facing Errors, resolves `{kind:'cancelled'}` on abort. */
async function runOcr(ctx: MainPluginContext, imageVaultPath: string, taskId?: string): Promise<OcrOutcome> {
  if (!ctx.llm.enabled()) {
    throw new Error('LLM features are disabled (Settings → LLM).');
  }
  if (!ctx.llm.capabilities().imageAttachments) {
    throw new Error('The active LLM provider cannot read images.');
  }

  const absolute = ctx.vault.resolveAssetPath(imageVaultPath);
  if (absolute === null) {
    throw new Error(`Image not found in the vault: ${imageVaultPath}`);
  }
  const ext = imageVaultPath.slice(imageVaultPath.lastIndexOf('.') + 1).toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (mediaType === undefined) {
    throw new Error(`Unsupported image type: .${ext}`);
  }
  let base64: string;
  try {
    base64 = Buffer.from(await readFile(absolute)).toString('base64');
  } catch {
    throw new Error(`Image could not be read: ${imageVaultPath}`);
  }

  const attachment: ChatAttachment = { kind: 'image', mediaType, base64 };
  try {
    const result = await ctx.llm.chat(
      [
        { role: 'system', content: OCR_SYSTEM },
        { role: 'user', content: OCR_USER },
      ],
      {
        ...(taskId !== undefined ? { taskId } : {}),
        maxOutputTokens: 4096,
        attachments: [attachment],
        onDelta: (delta) => ctx.ipc.emit('ocr:delta', { taskId, text: delta }),
      },
    );
    return { kind: 'ok', text: stripOuterFence(result.text.trim()) };
  } catch (err) {
    if (isAbortError(err)) {
      return { kind: 'cancelled' };
    }
    if (err instanceof TypeError && /^fetch failed/i.test(err.message)) {
      // undici's opaque transport failure — the endpoint is unreachable.
      throw new Error(
        `Could not reach the LLM endpoint — is the provider server running? ` +
          `(Settings → LLM; ${String(err)})`,
      );
    }
    throw err;
  }
}

const plugin: MainPluginModule = {
  async activate(ctx: MainPluginContext) {
    ctx.ipc.handle('ocr', (payload) => {
      const request = parseOcrPayload(payload);
      return runOcr(ctx, request.imageVaultPath, request.taskId);
    });
    ctx.log('activated');
  },
};

export default plugin;
