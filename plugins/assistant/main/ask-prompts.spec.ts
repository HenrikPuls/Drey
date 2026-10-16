import { describe, expect, it } from 'vitest';
import { buildAskUserMessage } from './ask-prompts';

describe('buildAskUserMessage — selection (milestone 74)', () => {
  const base = {
    question: ' Was heißt das? ',
    note: { path: 'a.md', body: 'Ganzer Text.' },
    extraFiles: [{ path: 'b.md', body: 'B.' }],
    images: [],
    chatPath: null,
    liveEdit: false,
    noteKey: null,
    vaultScope: 'off' as const,
    vaultIds: [],
    web: false,
  };

  it('places the selected section between the question and the document', () => {
    const message = buildAskUserMessage({ ...base, selection: 'Text.' });
    const blocks = message.split('\n\n').map((block) => block.split('\n')[0]);
    expect(blocks).toEqual([
      'INSTRUCTION / QUESTION:',
      'SELECTED SECTION (the question is about this part of the document):',
      'DOCUMENT (a.md):',
      'FILE (b.md):',
    ]);
    expect(message).toContain('document):\nText.\n\nDOCUMENT');
  });

  it('adds no block without a selection', () => {
    expect(buildAskUserMessage(base)).not.toContain('SELECTED SECTION');
    expect(buildAskUserMessage({ ...base, selection: '  ' })).not.toContain('SELECTED SECTION');
  });
});
