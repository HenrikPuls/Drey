import {
  buildTagSuggestionMessages,
  buildTaskMessages,
  normalizeTagToken,
  parseTagSuggestion,
  parseTaskClassification,
} from '../../../shared/llm';

describe('normalizeTagToken', () => {
  it('lower-cases, transliterates umlauts, and single-words', () => {
    expect(normalizeTagToken('Segeln')).toBe('segeln');
    expect(normalizeTagToken('Team Neptun')).toBe('team-neptun');
    expect(normalizeTagToken('Übergabe')).toBe('uebergabe');
    expect(normalizeTagToken('  #Kauf!  ')).toBe('kauf');
  });
});

describe('parseTagSuggestion', () => {
  it('parses a clean reply', () => {
    expect(parseTagSuggestion('{"vorschlaege": ["sailing"], "neuer_tag": null}')).toEqual({
      vorschlaege: ['sailing'],
      neuer_tag: null,
    });
  });

  it('unwraps a fenced / prefixed reply and caps at three suggestions', () => {
    const reply = 'Hier:\n```json\n{"vorschlaege":["a","b","c","d"],"neuer_tag":"kiel"}\n```';
    expect(parseTagSuggestion(reply)).toEqual({
      vorschlaege: ['a', 'b', 'c'],
      neuer_tag: 'kiel',
    });
  });

  it('de-duplicates and normalises suggested tokens', () => {
    expect(
      parseTagSuggestion('{"vorschlaege":["Sailing","sailing","Team X"],"neuer_tag":""}'),
    ).toEqual({
      vorschlaege: ['sailing', 'team-x'],
      neuer_tag: null,
    });
  });

  it('returns null when nothing usable came back', () => {
    expect(parseTagSuggestion('no json here')).toBeNull();
    expect(parseTagSuggestion('{"vorschlaege":[],"neuer_tag":null}')).toBeNull();
  });
});

describe('parseTaskClassification', () => {
  it('parses a task with due date and priority', () => {
    expect(
      parseTaskClassification('{"typ":"task","faelligkeit":"2026-09-10","prioritaet":"hoch"}'),
    ).toEqual({ typ: 'task', faelligkeit: '2026-09-10', prioritaet: 'hoch' });
  });

  it('rejects a bad date and a bad priority to null', () => {
    expect(
      parseTaskClassification('{"typ":"notiz","faelligkeit":"soon","prioritaet":"urgent"}'),
    ).toEqual({ typ: 'notiz', faelligkeit: null, prioritaet: null });
  });

  it('returns null without a valid typ', () => {
    expect(parseTaskClassification('{"faelligkeit":null}')).toBeNull();
  });
});

describe('message builders', () => {
  it('injects the current date into the task prompt', () => {
    const [system] = buildTaskMessages('etwas', new Date('2026-09-06T10:00:00'));
    expect(system.content).toContain('Heutiges Datum: 2026-09-06');
  });

  it('injects the registry into the tag-suggestion system prompt', () => {
    const msgs = buildTagSuggestionMessages(
      'Tags:\n{registry_list}\nEnde',
      '- a (thema): x',
      'notiz text',
    );
    expect(msgs[0].content).toBe('Tags:\n- a (thema): x\nEnde');
    expect(msgs[1]).toEqual({ role: 'user', content: 'notiz text' });
  });
});
