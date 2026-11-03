import { describe, expect, it } from 'vitest';
import { appendMemory, MEMORY_HEADER, MEMORY_LINE_CAP, memoryPathFor, parseMemoryEntries, toggleMemoryPin } from './persona-store';

/**
 * The persona memory store (ADR-0088, E3): one append = one line, the
 * file created with the `# Memory` header when absent, capped at
 * {@link MEMORY_LINE_CAP} lines with the oldest entries dropping first —
 * over an injected reader/writer pair, so any host drives it the same.
 */

function store(files: Map<string, string>) {
  const writes: { rel: string; text: string }[] = [];
  const read = async (rel: string): Promise<string> => {
    const text = files.get(rel);
    if (text === undefined) {
      throw new Error(`ENOENT: ${rel}`);
    }
    return text;
  };
  const write = async (rel: string, text: string): Promise<void> => {
    files.set(rel, text);
    writes.push({ rel, text });
  };
  return { read, write, writes };
}

const PIA = 'tickets/_meta/personas/pia/memory.md';

function contentLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop(); // the trailing newline is not a line
  }
  return lines;
}

describe('appendMemory', () => {
  it('creates the file with the # Memory header when absent', async () => {
    const files = new Map<string, string>();
    const { read, write, writes } = store(files);
    await appendMemory(read, write, 'pia', '- 2026-11-01 · T-0102 · handed-over · 1200 tokens');
    expect(files.get(PIA)).toBe('# Memory\n\n- 2026-11-01 · T-0102 · handed-over · 1200 tokens\n');
    expect(writes).toHaveLength(1);
  });

  it('appends below the header, one line per entry, oldest first', async () => {
    const files = new Map<string, string>([[PIA, '# Memory\n\n- first\n']]);
    const { read, write } = store(files);
    await appendMemory(read, write, 'pia', '- second');
    await appendMemory(read, write, 'pia', '- third');
    expect(files.get(PIA)).toBe('# Memory\n\n- first\n- second\n- third\n');
  });

  it(`caps the file at ${MEMORY_LINE_CAP} lines, dropping the oldest entries (header survives)`, async () => {
    const entries = Array.from({ length: 198 }, (_, i) => `- e${i}`);
    const files = new Map<string, string>([[PIA, `# Memory\n\n${entries.join('\n')}\n`]]);
    const { read, write } = store(files);
    await appendMemory(read, write, 'pia', '- e198');
    await appendMemory(read, write, 'pia', '- e199'); // one beyond the cap
    const lines = contentLines(files.get(PIA)!);
    expect(lines).toHaveLength(MEMORY_LINE_CAP);
    expect(lines[0]).toBe(MEMORY_HEADER);
    expect(lines).not.toContain('- e0'); // the oldest went first
    expect(lines).not.toContain('- e1');
    expect(lines).toContain('- e2');
    expect(lines[lines.length - 1]).toBe('- e199');
  });

  it('treats a blank file like an absent one', async () => {
    const files = new Map<string, string>([[PIA, '  \n\n']]);
    const { read, write } = store(files);
    await appendMemory(read, write, 'pia', '- fresh');
    expect(files.get(PIA)).toBe('# Memory\n\n- fresh\n');
  });

  it('keeps a headerless hand-written file headerless and still caps it', async () => {
    const entries = Array.from({ length: 201 }, (_, i) => `- hand ${i}`);
    const files = new Map<string, string>([[PIA, `${entries.join('\n')}\n`]]);
    const { read, write } = store(files);
    await appendMemory(read, write, 'pia', '- hand 201');
    const lines = contentLines(files.get(PIA)!);
    expect(lines).toHaveLength(MEMORY_LINE_CAP);
    expect(lines[0]).toBe('- hand 2');
    expect(lines[lines.length - 1]).toBe('- hand 201');
  });

  it('refuses an empty entry line', async () => {
    const files = new Map<string, string>();
    const { read, write } = store(files);
    await expect(appendMemory(read, write, 'pia', '   ')).rejects.toThrow('one non-empty line');
    expect(files.size).toBe(0);
  });
});

describe('memoryPathFor', () => {
  it('addresses the persona memory file under the personas dir', () => {
    expect(memoryPathFor('pia')).toBe('tickets/_meta/personas/pia/memory.md');
  });
});

describe('parseMemoryEntries + toggleMemoryPin (U4, concept §4.4)', () => {
  it('reads the entries back in file order, bullet and marker stripped', () => {
    const text = '# Memory\n\n- 2026-11-01 · T-0102 · rank fields win [pinned]\n- 2026-11-02 · T-0107 · gate red on lint\n';
    expect(parseMemoryEntries(text)).toEqual([
      { text: '2026-11-01 · T-0102 · rank fields win', pinned: true },
      { text: '2026-11-02 · T-0107 · gate red on lint', pinned: false },
    ]);
  });

  it('reads a headerless hand-written file and an empty one', () => {
    expect(parseMemoryEntries('- hand note\n')).toEqual([{ text: 'hand note', pinned: false }]);
    expect(parseMemoryEntries('')).toEqual([]);
    expect(parseMemoryEntries('   \n\n')).toEqual([]);
  });

  it('toggling the pin appends the marker at the line and strips it again — one entry changes', () => {
    const text = '# Memory\n\n- first\n- second\n- third\n';
    const pinned = toggleMemoryPin(text, 1, true);
    expect(pinned).toBe('# Memory\n\n- first\n- second [pinned]\n- third\n');
    expect(parseMemoryEntries(pinned!)).toEqual([
      { text: 'first', pinned: false },
      { text: 'second', pinned: true },
      { text: 'third', pinned: false },
    ]);
    expect(toggleMemoryPin(pinned!, 1, false)).toBe(text);
  });

  it('normalizes a hand-written bullet-less line to the canonical shape when pinning', () => {
    const text = 'hand note without a bullet\n';
    expect(toggleMemoryPin(text, 0, true)).toBe('- hand note without a bullet [pinned]\n');
    expect(parseMemoryEntries(toggleMemoryPin(text, 0, true)!)).toEqual([{ text: 'hand note without a bullet', pinned: true }]);
  });

  it('refuses an out-of-range index with null — never a silent no-op', () => {
    const text = '# Memory\n\n- only\n';
    expect(toggleMemoryPin(text, 1, true)).toBeNull();
    expect(toggleMemoryPin(text, -1, true)).toBeNull();
    expect(toggleMemoryPin('', 0, true)).toBeNull();
  });
});
