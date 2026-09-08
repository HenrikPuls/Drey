/**
 * Whether a filename / extension is a plain-text file whose contents can
 * be dropped straight into a note (`src/app/editor/image-paste.ts`). An
 * allowlist rather than a heuristic -- predictable, and it never tries to
 * inline a binary. Pure; the ~2 MB size cap is the caller's job.
 */

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'mdx',
  'rst',
  'adoc',
  'asciidoc',
  'org',
  'tex',
  'csv',
  'tsv',
  'json',
  'jsonc',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'xml',
  'svg',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'tsx',
  'vue',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'php',
  'pl',
  'lua',
  'r',
  'sh',
  'bash',
  'zsh',
  'fish',
  'bat',
  'cmd',
  'ps1',
  'sql',
  'graphql',
  'gql',
  'proto',
  'diff',
  'patch',
  'log',
  'gitignore',
  'gitattributes',
  'editorconfig',
  'dockerfile',
  'makefile',
]);

/**
 * `true` when `nameOrExt` (a filename, a vault-relative path, or a bare
 * extension with or without a leading dot) names a known text file.
 */
export function textExtension(nameOrExt: string): boolean {
  const value = nameOrExt.trim().toLowerCase();
  if (!value) {
    return false;
  }
  const dot = value.lastIndexOf('.');
  const slash = value.lastIndexOf('/');
  // A bare extension ("md", ".md"), or the part after the last dot in a name.
  const ext = dot > slash ? value.slice(dot + 1) : value.slice(slash + 1);
  return TEXT_EXTENSIONS.has(ext);
}
