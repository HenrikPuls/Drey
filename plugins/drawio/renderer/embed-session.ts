/**
 * One diagram tab's conversation with the draw.io editor frame (ADR-0064),
 * over draw.io's JSON embed protocol (`embed=1&proto=json`):
 *
 *   frame: {event:'init'}            -> host: {action:'load', xml, autosave:1}
 *   frame: {event:'autosave', xml}   -> host: store / export, then write
 *   frame: {event:'save', xml}       -> same, written at once
 *   host:  {action:'export', format:'xmlsvg' | 'xmlpng'}
 *   frame: {event:'export', data:'data:image/…;base64,…'}
 *
 * Pure: the frame, the file and the clock are ports, so the whole flow runs
 * in a unit test.
 *
 * Saving is automatic. A `.drawio` file is written from the XML the editor
 * reports. A picture diagram (`.drawio.svg` / `.drawio.png`) needs the
 * editor to render the picture, so every
 * change asks for an export at once (one in flight at a time) and the
 * debounce only delays the WRITE -- when the tab closes, the latest picture
 * is usually here already and is written without the frame. If the tab
 * closes while an export is still out, the last picture is written with
 * the newest diagram data put into it (`withDiagram`): the model is never
 * lost, the pixels catch up on the next edit.
 */

export interface EmbedSessionPorts {
  /** Send one protocol message to the editor frame. */
  post(message: Record<string, unknown>): void;
  /** Write the file (bytes for a PNG). Rejections are reported through `onError`. */
  write(content: string | Uint8Array): Promise<void>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onError(message: string): void;
}

export interface EmbedSessionOptions {
  /** `svg` / `png`: write the exported picture; `xml`: write the diagram XML. */
  readonly format: 'svg' | 'png' | 'xml';
  /** The diagram XML to load (`''` for a blank diagram). */
  readonly xml: string;
  /**
   * Picture formats: the file's content as loaded, and how to put new
   * diagram XML into a picture without re-rendering it (null = cannot).
   */
  readonly original?: string | Uint8Array;
  readonly withDiagram?: (picture: string | Uint8Array, xml: string) => string | Uint8Array | null;
  /** Quiet time after the last change before the file is written. */
  readonly debounceMs?: number;
}

export const AUTOSAVE_DEBOUNCE_MS = 1000;

const DATA_PREFIX = { svg: 'data:image/svg+xml;base64,', png: 'data:image/png;base64,' } as const;

/** The bytes of a base64 picture data URI as draw.io exports it, or null. */
export function decodePictureDataUri(data: unknown, format: 'svg' | 'png'): Uint8Array | null {
  const prefix = DATA_PREFIX[format];
  if (typeof data !== 'string' || !data.startsWith(prefix)) {
    return null;
  }
  try {
    return Uint8Array.from(atob(data.slice(prefix.length)), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The editor frame's URL below the bundled web app's root. */
export function editorFrameUrl(webappRoot: string, dark: boolean): string {
  const params = new URLSearchParams({
    embed: '1',
    proto: 'json',
    spin: '1',
    // No network: no cloud storage, no remote libraries, fonts or updates.
    offline: '1',
    stealth: '1',
    lang: 'en',
    libraries: '1',
    // Saving is automatic, so the frame shows neither Save nor Exit.
    noSaveBtn: '1',
    noExitBtn: '1',
    saveAndExit: '0',
    modified: '0',
    dark: dark ? '1' : '0',
  });
  return `${webappRoot}/index.html?${params.toString()}`;
}

export class EmbedSession {
  private readonly debounceMs: number;
  private loaded = false;
  private stopped = false;
  /** Content waiting to be written, null when the file is current. */
  private pending: string | Uint8Array | null = null;
  private timer: unknown = null;
  private exporting = false;
  private exportAgain = false;
  /** Whether the export in flight answers an explicit Save. */
  private immediate = false;
  /** The newest diagram XML the editor reported (picture formats). */
  private latestXml: string | null = null;
  /** The newest picture the editor rendered, else the file as loaded. */
  private lastPicture: string | Uint8Array | null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: EmbedSessionOptions,
    private readonly ports: EmbedSessionPorts,
  ) {
    this.debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
    this.lastPicture = options.original ?? null;
  }

  /** True once the editor has taken the diagram. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** One message from the editor frame (the raw `MessageEvent.data`). */
  handle(raw: unknown): void {
    if (this.stopped) {
      return;
    }
    const message = parseMessage(raw);
    if (message === null) {
      return;
    }
    switch (message['event']) {
      case 'init':
        this.ports.post({ action: 'load', xml: this.options.xml, autosave: 1 });
        break;
      case 'load':
        this.loaded = true;
        break;
      case 'autosave':
        this.changed(message['xml'], false);
        break;
      case 'save':
        this.changed(message['xml'], true);
        break;
      case 'export':
        this.exported(message['data']);
        break;
      default:
        break;
    }
  }

  /**
   * Stops writing to the file (it was deleted or moved away): pending
   * content is dropped rather than recreating the old path.
   */
  abandon(): void {
    this.stopped = true;
    this.pending = null;
    this.cancelTimer();
  }

  /** The tab closes: write what is pending, then resolve. */
  async dispose(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.cancelTimer();
      if (this.exporting && this.latestXml !== null && this.lastPicture !== null) {
        // The frame is gone before it rendered the last change.
        this.pending =
          this.options.withDiagram?.(this.lastPicture, this.latestXml) ?? this.pending;
      }
      this.flush();
    }
    await this.writeChain;
  }

  private changed(xml: unknown, immediately: boolean): void {
    // Nothing the editor says before it took the diagram is a user change.
    if (!this.loaded) {
      return;
    }
    if (this.options.format === 'xml') {
      if (typeof xml === 'string' && xml !== '') {
        this.schedule(xml, immediately);
      }
      return;
    }
    if (typeof xml === 'string' && xml !== '') {
      this.latestXml = xml;
    }
    this.immediate = this.immediate || immediately;
    if (this.exporting) {
      this.exportAgain = true;
      return;
    }
    this.requestExport();
  }

  private requestExport(): void {
    this.exporting = true;
    this.exportAgain = false;
    this.ports.post({
      action: 'export',
      format: this.options.format === 'png' ? 'xmlpng' : 'xmlsvg',
    });
  }

  private exported(data: unknown): void {
    if (!this.exporting) {
      return;
    }
    this.exporting = false;
    const format = this.options.format === 'png' ? 'png' : 'svg';
    const bytes = decodePictureDataUri(data, format);
    if (bytes === null) {
      this.ports.onError('The editor returned no picture for this diagram.');
    } else {
      const immediately = this.immediate && !this.exportAgain;
      this.lastPicture = format === 'png' ? bytes : new TextDecoder('utf-8').decode(bytes);
      this.schedule(format === 'png' ? bytes : new TextDecoder('utf-8').decode(bytes), immediately);
    }
    if (this.exportAgain) {
      this.requestExport();
    } else {
      this.immediate = false;
    }
  }

  private schedule(content: string | Uint8Array, immediately: boolean): void {
    this.pending = content;
    this.cancelTimer();
    if (immediately) {
      this.flush();
      return;
    }
    this.timer = this.ports.setTimer(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    const content = this.pending;
    if (content === null) {
      return;
    }
    this.pending = null;
    // One write at a time, in order: a slow write must not land after a
    // newer one.
    this.writeChain = this.writeChain
      .then(() => this.ports.write(content))
      .then(() => {
        if (!this.stopped) {
          this.ports.post({ action: 'status', modified: false });
        }
      })
      .catch((error: unknown) => {
        this.ports.onError(error instanceof Error ? error.message : String(error));
      });
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.ports.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

function parseMessage(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
