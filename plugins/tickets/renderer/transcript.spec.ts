import { describe, expect, it } from 'vitest';
import { transcriptMarkdown, YOU_PREFIX } from './transcript';

const line = (event: object): string => JSON.stringify(event);

describe('transcriptMarkdown', () => {
  it('renders replies as paragraphs and groups tool calls into one step run', () => {
    const md = transcriptMarkdown(
      [
        line({ kind: 'note', text: 'read src/a.ts' }),
        line({ kind: 'note', text: 'shell git status' }),
        line({ kind: 'text', text: 'Now I know the layout.' }),
        line({ kind: 'usage', tokensIn: 5 }),
      ].join('\n'),
    );
    expect(md).toBe('● **Read** `src/a.ts`  \n● **Shell** `git status`\n\nNow I know the layout.');
  });

  it("quotes the owner's prompts, results and errors", () => {
    const md = transcriptMarkdown(
      [
        line({ kind: 'note', text: `${YOU_PREFIX}compact, then continue` }),
        line({ kind: 'result', text: 'Done.' }),
        line({ kind: 'error', text: 'boom' }),
      ].join('\n'),
    );
    expect(md).toBe('> **›** compact, then continue\n\n---\n\n**✓ Turn finished**\n\nDone.\n\n**✗ Error** — boom');
  });

  it('keeps a note from breaking out of its code span and skips junk lines', () => {
    const md = transcriptMarkdown(`not json\n${line({ kind: 'note', text: 'a `b`\nc' })}\n${line({ kind: 'text', text: '' })}`);
    expect(md).toBe("● **A** `'b' c`");
  });

  it('shows the thinking of the worker as a one-line italic quote', () => {
    const md = transcriptMarkdown(line({ kind: 'note', text: 'thinking › First   look\nat the file' }));
    expect(md).toBe('> _∴ Thinking — First look at the file_');
  });

  it('drops a result body the last reply already said and folds run setup', () => {
    const md = transcriptMarkdown(
      [
        line({ kind: 'note', text: 'run R-1 for T-1 on t/T-1' }),
        line({ kind: 'text', text: 'All done.' }),
        line({ kind: 'result', text: 'All done.' }),
      ].join('\n'),
    );
    expect(md).toBe('<sub>run R-1 for T-1 on t/T-1</sub>\n\nAll done.\n\n---\n\n**✓ Turn finished**');
  });

  it('hangs a tool outcome under its call', () => {
    const md = transcriptMarkdown(
      [line({ kind: 'note', text: 'Read src/a.ts' }), line({ kind: 'note', text: 'result › 120 lines' })].join('\n'),
    );
    expect(md).toBe('● **Read** `src/a.ts`  \n&nbsp;&nbsp;⎿ _120 lines_');
  });

  it('is empty for an empty stream', () => {
    expect(transcriptMarkdown('')).toBe('');
  });
});
