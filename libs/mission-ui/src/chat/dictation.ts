/**
 * Dictation into the chat composer (E12-8, milestone 149): voice is an input
 * to the assistant, not a capture screen. The Web Speech API
 * (`SpeechRecognition`, `webkitSpeechRecognition` on iOS Safari) turns
 * speech into text; this file holds everything that is not the browser —
 * the state machine, the merge of interim and final results into the
 * composer text, the error sentences and the language pick — so a spec
 * can drive it with a fake recognition.
 *
 * Contract with the composer: interim results fill the draft live, the
 * final text stays in the draft and is never sent for the owner, the
 * owner's own typing ends a dictation, and sending (or leaving the page)
 * cancels it silently so a late result cannot land in the next message.
 */
import { signal } from '@angular/core';

// --- the slice of the Web Speech API this uses ------------------------------

export interface RecognitionAlternativeLike {
  readonly transcript: string;
}

export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternativeLike | undefined;
}

export interface RecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: RecognitionResultLike | undefined;
}

export interface RecognitionEventLike {
  readonly results: RecognitionResultListLike;
}

export interface RecognitionErrorEventLike {
  readonly error: string;
}

/** What `new SpeechRecognition()` gives — the members the dictation drives. */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type RecognitionCtor = new () => RecognitionLike;

// --- environment ---------------------------------------------------------------

export interface DictationEnv {
  /** The browser's recognition constructor; null when it has none. */
  readonly ctor: RecognitionCtor | null;
  /** HTTPS or localhost — iOS Safari refuses recognition anywhere else. */
  readonly secure: boolean;
  /** The recognition language (BCP 47). */
  readonly lang: string;
  readonly setInterval: (handler: () => void, ms: number) => unknown;
  readonly clearInterval: (id: unknown) => void;
}

interface SpeechWindow {
  SpeechRecognition?: RecognitionCtor;
  webkitSpeechRecognition?: RecognitionCtor;
  isSecureContext?: boolean;
}

/** The real browser's environment; a server render or a test without a window gets an unsupported one. */
export function browserDictationEnv(): DictationEnv {
  const win = (typeof window === 'undefined' ? {} : window) as SpeechWindow;
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const doc = typeof document === 'undefined' ? null : document;
  return {
    ctor: win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null,
    secure: win.isSecureContext === true,
    lang: resolveDictationLang(nav?.languages ?? (nav?.language !== undefined ? [nav.language] : []), doc?.documentElement.lang ?? ''),
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  };
}

export const FALLBACK_DICTATION_LANG = 'en-US';

/**
 * The recognition language: the device's first language, else the page's
 * `lang` attribute, else `en-US`. A bare `de` stays `de` — the engines
 * expand it themselves.
 */
export function resolveDictationLang(deviceLanguages: readonly string[], pageLang: string): string {
  const pick = (list: readonly string[]): string | null => {
    for (const lang of list) {
      if (/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(lang.trim())) {
        return lang.trim().replace('_', '-');
      }
    }
    return null;
  };
  return pick(deviceLanguages) ?? pick([pageLang]) ?? FALLBACK_DICTATION_LANG;
}

// --- transcript merging ------------------------------------------------------

/**
 * The composer text while dictating: what stood there before (`base`), then
 * the words the engine is sure of, then the words it still revises. One
 * space joins them; a base that ends in a newline or an empty base takes
 * the speech directly.
 */
export function mergeTranscript(base: string, finalText: string, interimText: string): string {
  const speech = `${finalText.trim()} ${interimText.trim()}`.trim();
  if (speech === '') {
    return base;
  }
  if (base === '' || /\s$/.test(base)) {
    return `${base}${speech}`;
  }
  return `${base} ${speech}`;
}

/** The final and the interim part of an engine's result list. */
export function splitResults(results: RecognitionResultListLike): { readonly final: string; readonly interim: string } {
  let final = '';
  let interim = '';
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const transcript = result?.[0]?.transcript ?? '';
    if (result?.isFinal === true) {
      final += `${transcript.trim()} `;
    } else {
      interim += `${transcript} `;
    }
  }
  return { final: final.trim(), interim: interim.trim() };
}

/** `0:03` — the recording timer. */
export function clockOf(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// --- errors ----------------------------------------------------------------------

export type DictationErrorKind = 'denied' | 'no-speech' | 'network' | 'no-microphone' | 'language' | 'unavailable';

const ERROR_TEXT: Readonly<Record<DictationErrorKind, string>> = {
  denied: 'Microphone access is blocked. Allow it for this site in the browser settings, then try again.',
  'no-speech': 'No speech heard. Tap the microphone and speak.',
  network: 'Dictation needs a network connection to the speech service.',
  'no-microphone': 'No microphone found on this device.',
  language: 'Dictation does not support this language here.',
  unavailable: 'Dictation stopped unexpectedly. Try again.',
};

export function dictationErrorText(kind: DictationErrorKind): string {
  return ERROR_TEXT[kind];
}

/** Maps the engine's error code; `aborted` is the owner's own stop and says nothing. */
export function dictationErrorKind(code: string): DictationErrorKind | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'denied';
    case 'no-speech':
      return 'no-speech';
    case 'network':
      return 'network';
    case 'audio-capture':
      return 'no-microphone';
    case 'language-not-supported':
      return 'language';
    default:
      return 'unavailable';
  }
}

// --- the state machine -------------------------------------------------------------

export type DictationState = 'idle' | 'starting' | 'recording';

/**
 * One dictation per composer. `toggle` starts or ends it; the text goes out
 * through `onText` as the whole new draft each time the engine speaks.
 */
export class Dictation {
  /** The browser can dictate here: it has an engine and is allowed to use it. */
  readonly supported: boolean;
  readonly state = signal<DictationState>('idle');
  /** Seconds since the recording began. */
  readonly seconds = signal(0);
  /** The inline sentence for the last failure; cleared by the next start. */
  readonly error = signal<string | null>(null);

  private recognition: RecognitionLike | null = null;
  private timer: unknown = null;
  private base = '';

  constructor(
    private readonly env: DictationEnv,
    private readonly onText: (text: string) => void,
  ) {
    this.supported = env.ctor !== null && env.secure;
  }

  /** Starts with `draft` as the text the speech is appended to, or ends a running dictation. */
  toggle(draft: string): void {
    if (this.state() === 'idle') {
      this.start(draft);
    } else {
      this.stop();
    }
  }

  private start(draft: string): void {
    if (!this.supported || this.env.ctor === null) {
      return;
    }
    this.error.set(null);
    this.base = draft;
    let recognition: RecognitionLike;
    try {
      recognition = new this.env.ctor();
    } catch {
      this.error.set(dictationErrorText('unavailable'));
      return;
    }
    recognition.lang = this.env.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (this.recognition === recognition) {
        this.state.set('recording');
        this.startClock();
      }
    };
    recognition.onresult = (event) => {
      if (this.recognition !== recognition) {
        return;
      }
      const { final, interim } = splitResults(event.results);
      this.onText(mergeTranscript(this.base, final, interim));
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition) {
        return;
      }
      const kind = dictationErrorKind(event.error);
      if (kind !== null) {
        this.error.set(dictationErrorText(kind));
      }
    };
    recognition.onend = () => {
      if (this.recognition === recognition) {
        this.finish();
      }
    };
    this.recognition = recognition;
    this.state.set('starting');
    this.seconds.set(0);
    try {
      recognition.start();
    } catch {
      this.finish();
      this.error.set(dictationErrorText('unavailable'));
    }
  }

  /** The owner ends the dictation: the engine delivers its last words, then ends. */
  stop(): void {
    const recognition = this.recognition;
    if (recognition === null) {
      return;
    }
    try {
      recognition.stop();
    } catch {
      this.finish();
    }
  }

  /**
   * Ends the dictation without letting another word through — for a send
   * and for leaving the page, where a late result would land in the next
   * message.
   */
  cancel(): void {
    const recognition = this.recognition;
    if (recognition === null) {
      return;
    }
    this.finish();
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.onstart = null;
    try {
      recognition.abort();
    } catch {
      // already ended
    }
  }

  private finish(): void {
    this.recognition = null;
    this.stopClock();
    this.state.set('idle');
  }

  private startClock(): void {
    this.stopClock();
    this.seconds.set(0);
    this.timer = this.env.setInterval(() => this.seconds.update((s) => s + 1), 1000);
  }

  private stopClock(): void {
    if (this.timer !== null) {
      this.env.clearInterval(this.timer);
      this.timer = null;
    }
  }
}
