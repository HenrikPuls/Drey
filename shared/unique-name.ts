/**
 * Picks a name that is free among `existing` siblings by appending
 * " copy", then " copy 2", " copy 3", … before the file extension:
 *
 *   foo.md         -> foo copy.md   -> foo copy 2.md
 *   bar (a folder) -> bar copy      -> bar copy 2
 *   foo copy.md    -> foo copy 2.md            (does not stack " copy copy")
 *
 * `existing` is the set of sibling names exactly as the filesystem reports
 * them (case-sensitive). Used by `VaultManager.copyEntry` / `duplicateEntry`.
 */
export function uniqueCopyName(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing);

  // Split the extension off a real dotted file name ("foo.md"); a dotfile
  // ("...gitignore") or an extensionless folder keeps its whole name.
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';

  // Strip an existing " copy" / " copy N" suffix so duplicating a copy
  // yields "foo copy 2", not "foo copy copy".
  const base = stem.replace(/ copy(?: \d+)?$/, '');

  for (let i = 1; ; i++) {
    const candidate = `${base}${i === 1 ? ' copy' : ` copy ${i}`}${ext}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
