/**
 * The task-line metadata completion source (`task-meta.ts`), pure and
 * DOM-free (the date picker only hangs off the options' `apply`
 * callbacks), so it is tested against a fake `CompletionContext` — the
 * same shape `src/app/editor/slash-activation.spec.ts` stubs for the
 * base. The regression at the core: `matchBefore` must hand the source
 * the exact typed word (not a leading-separator-prefixed match), or the
 * whole-word triggers never fire and the dropdown never appears.
 */
import { describe, expect, it } from 'vitest';
import type { CompletionContext } from '@codemirror/autocomplete';
import { taskMetaCompletionSource } from './task-meta.js';

/** A one-line (or few-line) fake doc with CM's `line` / `lineAt` shape. */
function fakeState(lines: readonly string[]) {
  return {
    doc: {
      lines: lines.length,
      line(n: number) {
        return { number: n, text: lines[n - 1] ?? '' };
      },
      lineAt(pos: number) {
        let offset = 0;
        for (let n = 1; n <= lines.length; n++) {
          const end = offset + lines[n - 1]!.length + 1;
          if (pos < end) {
            return { number: n, text: lines[n - 1] };
          }
          offset = end;
        }
        return { number: lines.length, text: lines[lines.length - 1] };
      },
    },
  };
}

/**
 * Mirrors CM6's `matchBefore`: the expression is matched leftmost against
 * the line text up to `pos`, and the match must end exactly at `pos`.
 */
function fakeContext(line: string, pos = line.length): CompletionContext {
  const state = fakeState([line]);
  return {
    state,
    pos,
    matchBefore(expr: RegExp) {
      const text = line.slice(0, pos);
      for (let start = 0; start <= text.length; start++) {
        const slice = text.slice(start);
        const match = new RegExp(expr.source, expr.flags.replace('g', '')).exec(slice);
        if (match !== null && match.index === 0 && start + match[0].length === text.length) {
          return { from: start, to: pos, text: slice };
        }
      }
      return null;
    },
  } as unknown as CompletionContext;
}

const labels = (result: { options: readonly { label: string }[] } | null): string[] =>
  result === null ? [] : result.options.map((o) => o.label);

describe('taskMetaCompletionSource', () => {
  it('fires on a checkbox line with the trigger at the end (the matchBefore regression)', () => {
    const result = taskMetaCompletionSource(fakeContext('- [ ] fix due')) as {
      from: number;
      options: readonly { label: string }[];
    } | null;
    expect(result).not.toBeNull();
    expect(result!.from).toBe(10); // the word start, not the separator before it
    expect(labels(result)).toEqual([
      '📅 Today',
      '📅 Tomorrow',
      '📅 In a week',
      '📅 Pick a date…',
    ]);
  });

  it('fires on a #task tag line and offers the priority glyphs for prio', () => {
    expect(labels(taskMetaCompletionSource(fakeContext('#task call Anna prio')))).toEqual([
      '🔺 Highest',
      '⏫ High',
      '🔽 Low',
    ]);
  });

  it('understands the German and the long triggers', () => {
    expect(labels(taskMetaCompletionSource(fakeContext('- [ ] a fällig')))).not.toHaveLength(0);
    expect(labels(taskMetaCompletionSource(fakeContext('- [ ] a priority')))).not.toHaveLength(0);
  });

  it('offers the remove options only when the token already sits on the line', () => {
    expect(
      labels(taskMetaCompletionSource(fakeContext('- [ ] a 📅 2026-10-09 due'))),
    ).toContain('Remove due date');
    expect(labels(taskMetaCompletionSource(fakeContext('- [ ] a due')))).not.toContain(
      'Remove due date',
    );
    expect(
      labels(taskMetaCompletionSource(fakeContext('- [ ] a ⏫ prio'))),
    ).toContain('Normal (remove priority)');
  });

  it('stays silent on a plain word, a non-task line, frontmatter and fences', () => {
    expect(taskMetaCompletionSource(fakeContext('- [ ] a overdue'))).toBeNull();
    expect(taskMetaCompletionSource(fakeContext('just due prose'))).toBeNull();
    expect(
      taskMetaCompletionSource(fakeContext('- [ ] a due ', 12)),
    ).toBeNull(); // cursor after the trailing space: no word ends there
    const frontmatter = fakeState(['---', '- [ ] due', '---', '']);
    expect(
      taskMetaCompletionSource({
        state: frontmatter,
        pos: 13, // end of line 2 ('---\n' = 4 chars + 9)
        matchBefore: fakeContext('- [ ] due').matchBefore,
      } as unknown as CompletionContext),
    ).toBeNull();
    const fenced = fakeState(['```', '- [ ] due', '```']);
    expect(
      taskMetaCompletionSource({
        state: fenced,
        pos: 13,
        matchBefore: fakeContext('- [ ] due').matchBefore,
      } as unknown as CompletionContext),
    ).toBeNull();
  });
});
