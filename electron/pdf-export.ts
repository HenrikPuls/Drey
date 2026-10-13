/**
 * Main-side "Export as PDF…" (editor `⋯` menu, tab context menu, Files
 * panel row). One flow: read the note (or take the renderer's live buffer),
 * render it to a self-contained paper-styled HTML page
 * (`shared/pdf-html.ts`), print that page in a hidden sandboxed window and
 * write `printToPDF`'s buffer to a user-chosen location. Notes with
 * ` ```mermaid ` fences get the mermaid UMD bundle inlined (see
 * {@link loadMermaidScript}) so the fences render as diagrams in the page.
 *
 * Deliberately NOT routed through `VaultManager.pickSavePath`: that dialog
 * is `.md`-locked and throws outside the vault, while an export is meant to
 * leave the vault (Desktop, mail drafts folder, ...). The note itself is
 * still resolved with the usual vault guards; only the TARGET is free.
 */
import { app, BrowserWindow, dialog } from 'electron';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolveAssetRef } from '../shared/asset-refs';
import { hasMathSyntax } from '../shared/markdown/math';
import { buildNotePdfHtml, hasMermaidFence } from '../shared/pdf-html';
import { PdfExportRequest } from '../shared/ipc-api';
import { VaultManager } from './vault-manager';
import { refocusRenderer } from './focus';

export interface PdfExportDeps {
  vaultManager: VaultManager;
  /** The window the native dialog parents to; null when it is gone. */
  getParentWindow: () => BrowserWindow | null;
}

let mermaidScriptPromise: Promise<string | null> | null = null;

/**
 * The mermaid UMD bundle, read once per session and only for notes that
 * actually contain a ` ```mermaid ` fence (it is ~3.5 MB). Resolved through
 * the packaged `dependencies` tree -- `app.asar/node_modules` in a packed
 * build (Electron's fs reads asar entries directly), the repo checkout in
 * dev. A failed read returns null and the export falls back to plain code
 * blocks.
 */
function loadMermaidScript(): Promise<string | null> {
  if (mermaidScriptPromise === null) {
    mermaidScriptPromise = (async () => {
      try {
        const nodeRequire = createRequire(__filename);
        const bundle = nodeRequire.resolve('mermaid/dist/mermaid.min.js');
        return await fsp.readFile(bundle, 'utf-8');
      } catch {
        return null;
      }
    })();
  }
  return mermaidScriptPromise;
}

let katexRuntimePromise: Promise<{ script: string; css: string } | null> | null = null;

/**
 * The KaTeX runtime (script + stylesheet), read once per session and only
 * for notes that actually contain math. The stylesheet ships with every
 * `url(fonts/…)` reference rewritten to a `data:` URL — the print page is
 * ONE self-contained file next to the vault, so relative font paths would
 * 404 and the formulas would fall back to browser serif. A failed read
 * returns null and the export keeps the LaTeX visible as source text.
 */
function loadKatexRuntime(): Promise<{ script: string; css: string } | null> {
  if (katexRuntimePromise === null) {
    katexRuntimePromise = (async () => {
      try {
        const nodeRequire = createRequire(__filename);
        const scriptPath = nodeRequire.resolve('katex/dist/katex.min.js');
        const cssPath = nodeRequire.resolve('katex/dist/katex.min.css');
        let css = await fsp.readFile(cssPath, 'utf-8');
        const fontsDir = path.join(path.dirname(cssPath), 'fonts');
        for (const name of await fsp.readdir(fontsDir)) {
          const ref = `fonts/${name}`;
          if (!css.includes(ref)) {
            continue;
          }
          const buf = await fsp.readFile(path.join(fontsDir, name));
          const mime = name.endsWith('.woff2')
            ? 'font/woff2'
            : name.endsWith('.woff')
              ? 'font/woff'
              : 'font/ttf';
          css = css.split(`url(${ref})`).join(`url(data:${mime};base64,${buf.toString('base64')})`);
        }
        return { script: await fsp.readFile(scriptPath, 'utf-8'), css };
      } catch {
        return null;
      }
    })();
  }
  return katexRuntimePromise;
}

export async function exportNoteToPdf(
  { vaultManager, getParentWindow }: PdfExportDeps,
  request: PdfExportRequest,
): Promise<string | null> {
  const content =
    request.content ?? (await vaultManager.readFile(request.path, request.vaultId)).content;

  // Image references resolve through the ONE shared candidate chain
  // (`shared/asset-refs.ts` — the same list the Live Preview widgets walk:
  // note-relative, vault root, then the attachments/ folders for a bare
  // name). Main resolves to absolute file:// URLs -- the temp page is
  // itself file://, so same-scheme subresources load unconditionally.
  const resolveImageSrc = (rawUrl: string): string | null => {
    const ref = resolveAssetRef(request.path, rawUrl);
    if (ref.kind === 'passthrough') {
      return ref.url;
    }
    for (const candidate of ref.candidates) {
      const absolute = vaultManager.resolveAssetPath(candidate, request.vaultId);
      if (absolute !== null && fs.existsSync(absolute)) {
        return pathToFileURL(absolute).href;
      }
    }
    return null;
  };

  // Mermaid fences render as diagrams: the UMD runtime is inlined into the
  // page and a bootstrap script swaps each rendered SVG in for its code
  // block (per-diagram 20 s cap; a parse error leaves the code block).
  // Only notes with such a fence pay the bundle read; a failed read
  // degrades to plain code blocks.
  const mermaidScript = hasMermaidFence(content) ? await loadMermaidScript() : null;

  // Math renders through the inlined KaTeX bootstrap (synchronous — no
  // settle wait needed); without the runtime the LaTeX stays visible.
  const katexRuntime = hasMathSyntax(content) ? await loadKatexRuntime() : null;

  const html = buildNotePdfHtml({
    markdown: content,
    title: path.basename(request.path).replace(/\.md$/i, ''),
    resolveImageSrc,
    mermaidRuntime: mermaidScript === null ? undefined : { script: mermaidScript },
    katexRuntime: katexRuntime === null ? undefined : katexRuntime,
  });

  const target = await pickExportTarget(getParentWindow(), vaultManager, request);
  if (target === null) {
    return null; // cancelled
  }

  // Print in a hidden, sandboxed window with no preload -- it renders one
  // generated page and needs nothing else. Note HTML is script-stripped in
  // the builder; the sandbox is the second layer, not the only one.
  const tempPath = path.join(app.getPath('temp'), `drey-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  await fsp.writeFile(tempPath, html, 'utf-8');
  let win: BrowserWindow | null = null;
  try {
    win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await win.loadFile(tempPath);
    // loadFile resolving does not mean the images have arrived; wait for
    // them (bounded -- a hung remote image must not hang the export).
    await win.webContents.executeJavaScript(
      `Promise.race([
         Promise.all(Array.from(document.images).map((img) =>
           img.complete ? null : new Promise((resolve) => { img.onload = img.onerror = resolve; }))),
         new Promise((resolve) => setTimeout(resolve, 10000)),
       ])`,
      true,
    );
    // Wait for the inlined mermaid runtime to settle every diagram
    // (rendered SVG or code-block fallback). The bootstrap caps each
    // diagram at 20 s; the outer race is the belt for a page that never
    // set the promise -- skipping the wait just prints the code blocks.
    if (mermaidScript !== null) {
      await win.webContents.executeJavaScript(
        `Promise.race([
           window.__dreyMermaidSettled ?? Promise.resolve(),
           new Promise((resolve) => setTimeout(resolve, 30000)),
         ])`,
        true,
      );
    }
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      // Inches (Electron 44 PrintToPDFMargins) -- normal page layout,
      // German-word-processor defaults: 2cm top/bottom, 2.5cm left/right.
      // With no @page rule in the page CSS these are the effective margins;
      // the footer page numbers sit inside the bottom band.
      margins: { top: 0.79, bottom: 0.79, left: 0.98, right: 0.79 },
      displayHeaderFooter: true,
      // Empty span: without it Chromium prints its default date/title header.
      headerTemplate: '<span></span>',
      // Header/footer templates inherit NO page CSS -- without an explicit
      // font-size the text renders at 0px, i.e. invisibly.
      footerTemplate:
        '<div style="width:100%;text-align:center;font-size:8px;color:#777;">' +
        '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    await fsp.writeFile(target, pdf);
    return target;
  } finally {
    if (win !== null && !win.isDestroyed()) {
      win.destroy();
    }
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * The native save dialog. Default location is the note's own folder (via
 * the containment-guarded `resolveAssetPath` -- a plain path resolution, no
 * existence requirement). `vaultId` is never defaulted through
 * `resolveVaultId`, so a scratch tab (`vaultId` absent, possibly no active
 * vault) still exports; the dialog just falls back to the bare name.
 */
async function pickExportTarget(
  parent: BrowserWindow | null,
  vaultManager: VaultManager,
  request: PdfExportRequest,
): Promise<string | null> {
  const baseName = path.basename(request.path).replace(/\.md$/i, '') || 'note';
  const noteDir = path.posix.dirname(request.path);
  const noteDirAbsolute =
    noteDir !== '.' ? vaultManager.resolveAssetPath(noteDir, request.vaultId) : null;
  const defaultPath =
    noteDirAbsolute !== null ? path.join(noteDirAbsolute, `${baseName}.pdf`) : `${baseName}.pdf`;

  const options = {
    title: 'Export as PDF',
    defaultPath,
    filters: [{ name: 'PDF document', extensions: ['pdf'] as string[] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'] as Array<'createDirectory' | 'showOverwriteConfirmation'>,
  };
  const result =
    parent !== null && !parent.isDestroyed()
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
  refocusRenderer(parent);
  if (result.canceled || !result.filePath) {
    return null;
  }
  let chosen = path.resolve(result.filePath);
  if (!chosen.toLowerCase().endsWith('.pdf')) {
    chosen += '.pdf';
  }
  return chosen;
}
