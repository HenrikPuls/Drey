import { describe, expect, it } from 'vitest';
import { transcriptMarkdown, YOU_PREFIX } from './transcript';

const line = (event: object): string => JSON.stringify(event);

describe('transcriptMarkdown', () => {
  it('renders replies as paragraphs and groups notes into one bullet run', () => {
    const md = transcriptMarkdown(
      [
        line({ kind: 'note', text: 'read src/a.ts' }),
        line({ kind: 'note', text: 'shell git status' }),
        line({ kind: 'text', text: 'Now I know the layout.' }),
        line({ kind: 'usage', tokensIn: 5 }),
      ].join('\n'),
    );
    expect(md).toBe("- `read src/a.ts`\n- `shell git status`\n\nNow I know the layout.");
  });

  it('quotes the owner\'s prompts, results and errors', () => {
    const md = transcriptMarkdown(
      [
        line({ kind: 'note', text: `${YOU_PREFIX}compact, then continue` }),
        line({ kind: 'result', text: 'Done.' }),
        line({ kind: 'error', text: 'boom' }),
      ].join('\n'),
    );
    expect(md).toBe('> **You** — compact, then continue\n\n**Turn finished**\n\nDone.\n\n**Error** — boom');
  });

  it('keeps a note from breaking out of its code span and skips junk lines', () => {
    const md = transcriptMarkdown(`not json\n${line({ kind: 'note', text: 'a `b`\nc' })}\n${line({ kind: 'text', text: '' })}`);
    expect(md).toBe("- `a 'b' c`");
  });

  it('shows the thinking of the worker as an italic quote', () => {
    const md = transcriptMarkdown(line({ kind: 'note', text: 'thinking › First   look\nat the file' }));
    expect(md).toBe('> _First look at the file_');
  });

  it('is empty for an empty stream', () => {
    expect(transcriptMarkdown('')).toBe('');
  });
});
