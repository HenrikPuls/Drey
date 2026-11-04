import { describe, expect, it } from 'vitest';
import { createDictation, dictationErrorText, recognitionCtorOf, type RecognitionLike } from './dictate';

class FakeRecognition implements RecognitionLike {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  onresult: RecognitionLike['onresult'] = null;
  onerror: RecognitionLike['onerror'] = null;
  onend: RecognitionLike['onend'] = null;
  started = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.onend?.();
  }
}

const result = (transcript: string, isFinal: boolean) => ({ isFinal, 0: { transcript } });

describe('recognitionCtorOf', () => {
  it('is null without the API and finds the prefixed constructor', () => {
    expect(recognitionCtorOf({})).toBeNull();
    expect(recognitionCtorOf({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
  });
});

describe('createDictation', () => {
  it('reports the whole transcript so far and ends once', () => {
    const dictation = createDictation(FakeRecognition, 'de-DE');
    const texts: string[] = [];
    const ends: (string | null)[] = [];
    dictation.start(
      (t) => texts.push(t),
      (e) => ends.push(e),
    );
    const recognition = FakeRecognition.last!;
    expect(recognition.lang).toBe('de-DE');
    expect(recognition.interimResults).toBe(true);
    expect(dictation.listening).toBe(true);
    recognition.onresult?.({ resultIndex: 0, results: [result('hello ', true), result('wor', false)] });
    expect(texts).toEqual(['hello wor']);
    dictation.stop();
    expect(ends).toEqual([null]);
    expect(dictation.listening).toBe(false);
  });

  it('carries an error code to the end callback, but not our own abort', () => {
    const dictation = createDictation(FakeRecognition, 'en-US');
    const ends: (string | null)[] = [];
    dictation.start(
      () => undefined,
      (e) => ends.push(e),
    );
    FakeRecognition.last!.onerror?.({ error: 'not-allowed' });
    FakeRecognition.last!.onend?.();
    dictation.start(
      () => undefined,
      (e) => ends.push(e),
    );
    FakeRecognition.last!.onerror?.({ error: 'aborted' });
    FakeRecognition.last!.onend?.();
    expect(ends).toEqual([dictationErrorText('not-allowed'), null]);
  });
});
