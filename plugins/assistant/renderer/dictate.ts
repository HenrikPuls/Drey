/**
 * Dictation into the Assistant composer (E13-5, owner decision 2026-11-04:
 * voice is input to the assistant): the Web Speech API where the page has
 * it, nothing where it does not (the button stays hidden). The recognizer
 * constructor is injected so the spec runs without a browser.
 */

interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}

interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResultLike>;
}

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export type RecognitionCtor = new () => RecognitionLike;

/** The constructor the page offers, standard name first; null = no dictation here. */
export function recognitionCtorOf(scope: object): RecognitionCtor | null {
  const holder = scope as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const ctor = holder.SpeechRecognition ?? holder.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as RecognitionCtor) : null;
}

/** Words for an error code of the recognizer; the Assistant shows it under the composer. */
export function dictationErrorText(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Dictation needs microphone access — it was not granted.';
    case 'no-speech':
      return 'No speech heard.';
    case 'audio-capture':
      return 'No microphone found.';
    case 'network':
      return 'Dictation could not reach its speech service.';
    default:
      return `Dictation stopped (${code}).`;
  }
}

export interface Dictation {
  readonly listening: boolean;
  /**
   * Starts listening. `onText` gets the whole transcript so far (final
   * plus the current guess) on every result; `onEnd` fires once when it
   * stopped, with the error text when it ended on an error.
   */
  start(onText: (transcript: string) => void, onEnd: (error: string | null) => void): void;
  stop(): void;
}

export function createDictation(ctor: RecognitionCtor, lang: string): Dictation {
  let recognition: RecognitionLike | null = null;
  return {
    get listening() {
      return recognition !== null;
    },
    start: (onText, onEnd) => {
      if (recognition !== null) {
        return;
      }
      const current = new ctor();
      recognition = current;
      current.lang = lang;
      current.continuous = true;
      current.interimResults = true;
      let error: string | null = null;
      current.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i += 1) {
          transcript += event.results[i]?.[0].transcript ?? '';
        }
        onText(transcript);
      };
      current.onerror = (event) => {
        // 'aborted' is our own stop().
        error = event.error === 'aborted' ? null : dictationErrorText(event.error);
      };
      current.onend = () => {
        recognition = null;
        onEnd(error);
      };
      try {
        current.start();
      } catch (failure) {
        recognition = null;
        onEnd(failure instanceof Error ? failure.message : String(failure));
      }
    },
    stop: () => {
      recognition?.stop();
    },
  };
}
