/**
 * The ocr plugin's pure core, shared by its main and renderer entries:
 * payload validation, the image-target extraction from a click (widget
 * `src` reverse map or raw `![…](…)` line), the fence-tolerant reply
 * cleanup, and the below-the-image insertion composition.
 *
 * No imports at all — this file is compiled into BOTH plugin builds, and
 * the renderer build must stay free of bare-specifier runtime imports.
 * `normalizeRelative` is deliberately duplicated from
 * `src/app/editor/vault-image.ts`: plugins may import base `shared/` but
 * never `src/app/**`.
 */

/** The renderer->main request for one OCR run. */
export interface OcrRequest {
  /** Vault-relative path of the image to transcribe. */
  readonly imageVaultPath: string;
  /** Renderer-minted task id (`api.llm.cancelTask`); absent = uncancellable. */
  readonly taskId?: string;
}

/** What the main side reports for one OCR run. */
export type OcrOutcome = { readonly kind: 'ok'; readonly text: string } | { readonly kind: 'cancelled' };

/** Image extension -> media type (the ChatAttachment dialect). */
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Strict payload validation for the `ocr` backend method — a malformed
 * payload must fail VISIBLY with a clear message, never coerce.
 */
export function parseOcrPayload(payload: unknown): OcrRequest {
  const shape = (payload ?? {}) as Record<string, unknown>;
  if (typeof shape['imageVaultPath'] !== 'string' || shape['imageVaultPath'] === '') {
    throw new Error('malformed ocr payload: imageVaultPath must be a non-empty string');
  }
  if (
    shape['taskId'] !== undefined &&
    shape['taskId'] !== null &&
    typeof shape['taskId'] !== 'string'
  ) {
    throw new Error('malformed ocr payload: taskId must be a string when given');
  }
  return {
    imageVaultPath: shape['imageVaultPath'],
    ...(typeof shape['taskId'] === 'string' ? { taskId: shape['taskId'] } : {}),
  };
}

/**
 * Reverse of the base `resolveVaultImageUrl`: a `drey-asset://` URL back
 * into the vault-relative path, decoding each segment. Tolerates both wire
 * shapes — the legacy `drey-asset://asset/<path>` (host = `asset`) and the
 * per-vault `drey-asset://<vaultId>/asset/<path>` (ADR-0051). `null` for
 * http(s):/data:/any other scheme — the row only makes sense for
 * vault-resolved images.
 */
export function imageVaultPathFromUrl(url: string): string | null {
  const match = /^drey-asset:\/\/[^/]+\/(?:asset\/)?(.+)$/.exec(url);
  if (match === null) {
    return null;
  }
  const rest = match[1];
  if (rest === '') {
    return null;
  }
  try {
    return rest
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return null; // a malformed escape is not a path we can trust
  }
}

/** Collapse `.`/`..` segments; `null` when the path climbs above the root. */
function normalizeRelative(pathStr: string): string | null {
  const out: string[] = [];
  for (const seg of pathStr.split('/')) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (out.length === 0) {
        return null;
      }
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

/**
 * The first Markdown image target on a raw source line
 * (`![alt](path)` — the Obsidian `|300` size suffix lives in the alt, so
 * it never reaches the URL). Resolves the target relative to the note's
 * own folder; `null` for http(s)/data/explicit schemes, vault escapes, and
 * lines without an image.
 */
export function imageTargetFromLine(line: string, docPath: string): string | null {
  const raw = rawImageTargetFromLine(line);
  if (raw === null) {
    return null;
  }
  const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  return normalizeRelative(baseDir !== '' ? `${baseDir}/${raw}` : raw);
}

/**
 * The raw `![…](…)` target as written (trimmed), or null for lines without
 * an image or with an http(s)/data/explicit-scheme target — the caller
 * decides how to interpret it.
 */
export function rawImageTargetFromLine(line: string): string | null {
  const match = /!\[[^\]]*\]\((?:<([^>]+)>|([^)\s]+))\)/.exec(line);
  const raw = match?.[1] ?? match?.[2];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const url = raw.trim();
  if (/^(https?:|data:)/i.test(url)) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return null;
  }
  return url;
}

/**
 * Ordered vault-relative interpretations of one raw image target,
 * mirroring the base `resolveVaultImageCandidates`: note-relative first
 * (the documented semantics), then the same path read from the vault root
 * (assistant chat notes embed vault-relative attachment paths). The
 * renderer picks via the vault file list — a target present under the
 * note-relative reading wins.
 */
export function imageTargetCandidates(rawUrl: string, docPath: string): string[] {
  const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const noteRelative = normalizeRelative(baseDir !== '' ? `${baseDir}/${rawUrl}` : rawUrl);
  const fromRoot = normalizeRelative(rawUrl);
  const out: string[] = [];
  if (noteRelative !== null && noteRelative !== '' && !out.includes(noteRelative)) {
    out.push(noteRelative);
  }
  if (fromRoot !== null && fromRoot !== '' && !out.includes(fromRoot)) {
    out.push(fromRoot);
  }
  return out;
}

/**
 * Drops ONE outer triple-backtick fence (optional language tag) when it
 * wraps the WHOLE reply — models like to fence transcriptions despite the
 * prompt. Tolerant-parse stance, same as the base `parseJsonObject`.
 */
export function stripOuterFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match === null ? text : match[1];
}

/**
 * The `after` for an embedded-image OCR: the transcription spliced in
 * AFTER line `lineNumber` (1-based), separated by one blank line — plain
 * Markdown, no callout wrapper. Buffers are LF internally.
 */
export function composeInsertedBelow(before: string, lineNumber: number, text: string): string {
  const lines = before.split('\n');
  const insertion = ['', ...text.split('\n')];
  lines.splice(lineNumber, 0, ...insertion);
  return lines.join('\n');
}

/**
 * First 1-based line of `buffer` referencing `imageVaultPath` (the same
 * note-relative resolution the click-path regex uses). Recovery path for a
 * click that mapped to the image but not to a document position (widget
 * DOM outside the view's mapping) — insertion needs SOME line to sit below.
 */
export function findImageLine(
  buffer: string,
  imageVaultPath: string,
  docPath: string,
): number | null {
  const lines = buffer.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (imageTargetFromLine(lines[i], docPath) === imageVaultPath) {
      return i + 1;
    }
  }
  return null;
}
