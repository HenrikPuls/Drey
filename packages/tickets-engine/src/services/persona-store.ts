import { PERSONAS_DIR } from '../core/persona';

/**
 * The persona memory store (ADR-0088, E3): the one writer for
 * `tickets/_meta/personas/<id>/memory.md` — the curated, per-persona
 * lesson log a run's instruction later reads back as the `## Memory`
 * slice (T-0048 context pack). Pure IO shape: a vault-relative reader and
 * writer are all it needs, so any host (the Drey plugin, the standalone
 * engine, the fleet runner on settle) drives it the same way. The caller's
 * writer is expected to mkdir as needed — this store never touches the
 * disk directly.
 *
 * The file shape stays deliberately boring:
 *
 *   # Memory
 *
 *   - 2026-11-01 · T-0102 · handed-over · 1200 tokens
 *   - 2026-11-02 · T-0107 · failed · gate red on lint
 *
 * One line per entry, oldest first, the file capped at
 * {@link MEMORY_LINE_CAP} lines (the `# Memory` header is never dropped).
 */

const NL = String.fromCharCode(10);

export const MEMORY_HEADER = '# Memory';
/** The memory file never grows past this many lines; the oldest entries go first. */
export const MEMORY_LINE_CAP = 200;

/** The vault-relative path of one persona's memory file. */
export function memoryPathFor(id: string): string {
  return `${PERSONAS_DIR}/${id}/memory.md`;
}

/**
 * Appends exactly one entry line, creating the file (with the
 * `# Memory` header) when absent, and caps the file at
 * {@link MEMORY_LINE_CAP} lines by dropping the oldest entries. An
 * existing hand-written file without a header keeps its shape — the
 * header is added only at creation.
 */
export async function appendMemory(
  read: (rel: string) => Promise<string>,
  write: (rel: string, text: string) => Promise<void>,
  id: string,
  entryLine: string,
): Promise<void> {
  const entry = entryLine.trim();
  if (entry === '') {
    throw new Error('a memory entry is one non-empty line');
  }
  const rel = memoryPathFor(id);
  let existing = '';
  try {
    existing = await read(rel);
  } catch {
    // absent (or unreadable) — the append creates the file below
  }

  let header: string[];
  let entries: string[];
  if (existing.trim() === '') {
    header = [MEMORY_HEADER, ''];
    entries = [];
  } else {
    const lines = existing.split(NL);
    const hasHeader = (lines[0] ?? '').startsWith('#');
    header = hasHeader ? [lines[0]!, ''] : [];
    entries = (hasHeader ? lines.slice(1) : lines).filter((line) => line.trim() !== '');
  }
  entries.push(entry);
  const maxEntries = MEMORY_LINE_CAP - header.length;
  while (entries.length > maxEntries) {
    entries.shift(); // the oldest lesson goes first — the cap never drops the header
  }
  const text = `${[...header, ...entries].join(NL)}${NL}`;
  await write(rel, text);
}
