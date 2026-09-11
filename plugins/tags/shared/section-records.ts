/**
 * Turns raw note text into the tagged-section records the tag search
 * consumes: split into heading-delimited sections, keep the ones carrying
 * at least one inline `#tag`, fall back to the file's base name for the
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
    const tags = extractInlineTags(`${section.heading}\n${section.text}`);
    if (tags.length === 0) {
      continue;
    }
    out.push({
      path,
      heading: section.heading || base,
      line: section.line,
      tags,
      text: section.text,
    });
  }
  return out;
}
