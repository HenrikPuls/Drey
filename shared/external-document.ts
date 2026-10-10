/**
 * Documents Drey does not show itself: they open in the program the OS
 * associates with them (ADR-0066). An allowlist rather than "everything
 * that is not text" -- a link in a note must never be able to launch an
 * executable, a script or a shortcut. Pure; shared by the renderer (the
 * open routing, the drop cascade) and the main process (which checks again
 * before it hands a path to the OS).
 */

const EXTERNAL_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  // Word / text documents
  'doc',
  'docx',
  'docm',
  'dot',
  'dotx',
  'rtf',
  'odt',
  // Excel / spreadsheets
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  'xlt',
  'xltx',
  'ods',
  // PowerPoint / presentations
  'ppt',
  'pptx',
  'pptm',
  'pps',
  'ppsx',
  'pot',
  'potx',
  'odp',
  // Other Office programs
  'vsd',
  'vsdx',
  'mpp',
  'pub',
  'one',
  'loop',
  'fluid',
  // Mail items
  'msg',
  'eml',
]);

/**
 * The extension (no dot, lower-case) when `nameOrPath` -- a file name, a
 * vault-relative path or an absolute path -- names a document that opens
 * in its own program, else `null`. Same contract as `imageExtension`.
 */
export function externalDocumentExtension(nameOrPath: string): string | null {
  const value = nameOrPath.trim().toLowerCase();
  const dot = value.lastIndexOf('.');
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (dot <= slash + 1 || dot === value.length - 1) {
    return null;
  }
  const ext = value.slice(dot + 1);
  return EXTERNAL_DOCUMENT_EXTENSIONS.has(ext) ? ext : null;
}

/**
 * The `file:` link target for an absolute path on this machine
 * (`C:\Docs\My report.docx` -> `file:///C:/Docs/My%20report.docx`), or
 * `null` for anything that is not a drive-letter or POSIX absolute path --
 * a network share (`\\server\...`) is refused, here and again in main.
 * Every character Markdown or a URL would trip over is percent-encoded,
 * so the result needs no `<...>` wrapping.
 */
export function localFileHref(absolutePath: string): string | null {
  const forward = absolutePath.trim().replace(/\\/g, '/');
  if (forward.startsWith('//')) {
    return null;
  }
  const rooted = /^[a-z]:\//i.test(forward) ? `/${forward}` : forward;
  if (!rooted.startsWith('/') || rooted.length < 2) {
    return null;
  }
  const encoded = rooted
    .split('/')
    .map((segment, index) =>
      // The drive segment keeps its colon (`C:`).
      index === 1 && /^[a-z]:$/i.test(segment)
        ? segment
        : encodeURIComponent(segment).replace(/[()']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join('/');
  return `file://${encoded}`;
}
