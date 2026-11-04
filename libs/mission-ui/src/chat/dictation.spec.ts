import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Dictation,
  FALLBACK_DICTATION_LANG,
  clockOf,
  dictationErrorKind,
  dictationErrorText,
  mergeTranscript,
  resolveDictationLang,
  splitResults,
  type DictationEnv,
  type RecognitionEventLike,
  type RecognitionLike,
  type RecognitionResultLike,
} from './dictation';

/** A recognition the spec drives by hand. */
class FakeRecognition implements RecognitionLike {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: RecognitionEventLike) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  constructor() {
    FakeRecognition.last = this;
  }
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  abort(): void {
    this.aborted++;
  }
  /** The engine opened the microphone. */
  begin(): void {
    this.onstart?.();
  }
  /** The engine delivers its whole result list. */
  say(...parts: readonly [string, boolean][]): void {
    const results = parts.map(([transcript, isFinal]): RecognitionResultLike => ({ isFinal, length: 1, 0: { transcript } }));
    this.onresult?.({ results: Object.assign(results, { length: results.length }) });
  }
  fail(error: string): void {
    this.onerror?.({ error });
  }
  end(): void {
    this.onend?.();
  }
}

function envOf(over: Partial<DictationEnv> = {}): DictationEnv {
  return {
    ctor: FakeRecognition,
    secure: true,
    lang: 'de-DE',
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    ...over,
  };
}

beforeEach(() => {
  FakeRecognition.last = null;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mergeTranscript', () => {
  it('appends the speech to the draft with one space', () => {
    expect(mergeTranscript('T-0084 back', 'to Ralf', '')).toBe('T-0084 back to Ralf');
    expect(mergeTranscript('a', 'b', 'c')).toBe('a b c');
  });

  it('takes speech directly after an empty base or a newline', () => {
    expect(mergeTranscript('', 'hello', 'wor')).toBe('hello wor');
    expect(mergeTranscript('line\n', 'hello', '')).toBe('line\nhello');
    expect(mergeTranscript('trailing ', 'x', '')).toBe('trailing x');
  });

  it('leaves the base alone when nothing was said', () => {
    expect(mergeTranscript('keep', '', '')).toBe('keep');
    expect(mergeTranscript('keep', '  ', ' ')).toBe('keep');
  });
});

describe('splitResults', () => {
  it('separates the sure words from the ones still revised', () => {
    const results = Object.assign(
      [
        { isFinal: true, length: 1, 0: { transcript: ' New ticket ' } },
        { isFinal: true, length: 1, 0: { transcript: 'storage scout' } },
        { isFinal: false, length: 1, 0: { transcript: 'and then' } },
      ] as RecognitionResultLike[],
      {},
    );
    expect(splitResults(results)).toEqual({ final: 'New ticket storage scout', interim: 'and then' });
  });
});

describe('resolveDictationLang', () => {
  it('prefers the device language, then the page, then English', () => {
    expect(resolveDictationLang(['de-DE', 'en-US'], 'en')).toBe('de-DE');
    expect(resolveDictationLang([], 'fr')).toBe('fr');
    expect(resolveDictationLang([], '')).toBe(FALLBACK_DICTATION_LANG);
    expect(resolveDictationLang(['', 'x'], '')).toBe(FALLBACK_DICTATION_LANG);
    expect(resolveDictationLang(['de_AT'], '')).toBe('de-AT');
  });
});

describe('clockOf', () => {
  it('writes m:ss', () => {
    expect(clockOf(0)).toBe('0:00');
    expect(clockOf(3)).toBe('0:03');
    expect(clockOf(75.9)).toBe('1:15');
  });
});

describe('error mapping', () => {
  it('names every engine code the phone can hit', () => {
    expect(dictationErrorKind('not-allowed')).toBe('denied');
    expect(dictationErrorKind('service-not-allowed')).toBe('denied');
    expect(dictationErrorKind('no-speech')).toBe('no-speech');
    expect(dictationErrorKind('network')).toBe('network');
    expect(dictationErrorKind('audio-capture')).toBe('no-microphone');
    expect(dictationErrorKind('language-not-supported')).toBe('language');
    expect(dictationErrorKind('weird')).toBe('unavailable');
    expect(dictationErrorKind('aborted')).toBeNull();
    expect(dictationErrorText('denied')).toMatch(/blocked/);
  });
});

describe('Dictation', () => {
  it('is unsupported without an engine or off a secure origin', () => {
    expect(new Dictation(envOf({ ctor: null }), () => undefined).supported).toBe(false);
    expect(new Dictation(envOf({ secure: false }), () => undefined).supported).toBe(false);
    expect(new Dictation(envOf(), () => undefined).supported).toBe(true);
  });

  it('does nothing when unsupported', () => {
    const dictation = new Dictation(envOf({ secure: false }), () => undefined);
    dictation.toggle('');
    expect(dictation.state()).toBe('idle');
    expect(FakeRecognition.last).toBeNull();
  });

  it('starts the engine with the device language, continuous and interim', () => {
    const dictation = new Dictation(envOf(), () => undefined);
    dictation.toggle('');
    const engine = FakeRecognition.last!;
    expect([engine.lang, engine.continuous, engine.interimResults, engine.started]).toEqual(['de-DE', true, true, 1]);
    expect(dictation.state()).toBe('starting');
    engine.begin();
    expect(dictation.state()).toBe('recording');
  });

  it('fills the draft live and keeps it as the engine settles', () => {
    const drafts: string[] = [];
    const dictation = new Dictation(envOf(), (text) => drafts.push(text));
    dictation.toggle('T-0084 back');
    const engine = FakeRecognition.last!;
    engine.begin();
    engine.say(['to', false]);
    engine.say(['to Ralf', false]);
    engine.say(['to Ralf', true]);
    engine.say(['to Ralf', true], ['and ship it', false]);
    expect(drafts).toEqual(['T-0084 back to', 'T-0084 back to Ralf', 'T-0084 back to Ralf', 'T-0084 back to Ralf and ship it']);
  });

  it('counts the seconds while recording and stops counting at the end', () => {
    const dictation = new Dictation(envOf(), () => undefined);
    dictation.toggle('');
    FakeRecognition.last!.begin();
    vi.advanceTimersByTime(3000);
    expect(dictation.seconds()).toBe(3);
    FakeRecognition.last!.end();
    expect(dictation.state()).toBe('idle');
    vi.advanceTimersByTime(5000);
    expect(dictation.seconds()).toBe(3);
  });

  it('a second toggle stops gracefully and the last words still land', () => {
    const drafts: string[] = [];
    const dictation = new Dictation(envOf(), (text) => drafts.push(text));
    dictation.toggle('');
    const engine = FakeRecognition.last!;
    engine.begin();
    dictation.toggle('');
    expect(engine.stopped).toBe(1);
    expect(dictation.state()).toBe('recording');
    engine.say(['last words', true]);
    engine.end();
    expect(drafts).toEqual(['last words']);
    expect(dictation.state()).toBe('idle');
  });

  it('cancel silences the engine: a late result never reaches the draft', () => {
    const drafts: string[] = [];
    const dictation = new Dictation(envOf(), (text) => drafts.push(text));
    dictation.toggle('');
    const engine = FakeRecognition.last!;
    engine.begin();
    dictation.cancel();
    expect(engine.aborted).toBe(1);
    expect(dictation.state()).toBe('idle');
    engine.say(['too late', true]);
    expect(drafts).toEqual([]);
  });

  it('shows a clear sentence for a refused microphone and goes idle', () => {
    const dictation = new Dictation(envOf(), () => undefined);
    dictation.toggle('');
    FakeRecognition.last!.fail('not-allowed');
    FakeRecognition.last!.end();
    expect(dictation.error()).toBe(dictationErrorText('denied'));
    expect(dictation.state()).toBe('idle');
  });

  it('reports no speech and network errors, and a new start clears the message', () => {
    const dictation = new Dictation(envOf(), () => undefined);
    dictation.toggle('');
    FakeRecognition.last!.fail('no-speech');
    FakeRecognition.last!.end();
    expect(dictation.error()).toBe(dictationErrorText('no-speech'));
    dictation.toggle('');
    expect(dictation.error()).toBeNull();
    FakeRecognition.last!.fail('network');
    expect(dictation.error()).toBe(dictationErrorText('network'));
  });

  it('an abort the owner caused says nothing', () => {
    const dictation = new Dictation(envOf(), () => undefined);
    dictation.toggle('');
    FakeRecognition.last!.fail('aborted');
    expect(dictation.error()).toBeNull();
  });

  it('survives an engine that throws on start', () => {
    class Broken extends FakeRecognition {
      override start(): void {
        throw new Error('already started');
      }
    }
    const dictation = new Dictation(envOf({ ctor: Broken }), () => undefined);
    dictation.toggle('');
    expect(dictation.state()).toBe('idle');
    expect(dictation.error()).toBe(dictationErrorText('unavailable'));
  });

  it('a result of a replaced engine is ignored', () => {
    const drafts: string[] = [];
    const dictation = new Dictation(envOf(), (text) => drafts.push(text));
    dictation.toggle('');
    const first = FakeRecognition.last!;
    first.end();
    dictation.toggle('');
    first.say(['stale', true]);
    expect(drafts).toEqual([]);
  });
});
