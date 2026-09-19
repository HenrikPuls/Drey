/**
 * Turns raw note text into the section records the tag search consumes:
 * split into heading-delimited sections, EVERY section kept — since
 * milestone 33 the untagged ones too, so free-text search covers notes
 * without any inline `#tag` (tag-only queries still require the tags, so
 * untagged sections never surface there) — and the file's base name as the
 * pre-heading part's heading.
 *
 * The single source of truth for "what the index records for this text".
 * The main-process `TagIndex` uses it for files on disk; the renderer's
 * search uses it on the live buffer of an open tab, so an unsaved edit is
 * searched exactly as it will be once saved.
 */
// Sibling specifiers need the explicit `.js`: this file is emitted BOTH as
// CJS (main, where Node16 maps .js -> .ts) and as ESM served over plugin://
// (where the browser resolves the specifier verbatim — extensionless 404s).
import { extractInlineTags } from './tags.js';
import { splitSections } from './sections.js';
import type { SearchableSection } from './search.js';

export function sectionRecordsFor(path: string, content: string): SearchableSection[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const out: SearchableSection[] = [];
  for (const section of splitSections(content)) {
    out.push({
      path,
      heading: section.heading || base,
      line: section.line,
      tags: extractInlineTags(`${section.heading}\n${section.text}`),
      text: section.text,
    });
  }
  return out;
}
