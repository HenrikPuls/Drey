import { vi } from 'vitest';
import { PdfPreviewWidget, PdfWidget } from './widgets';

/** A HEAD probe that never answers — `mount` takes the error path. */
function stubFetchNeverOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('unreachable'))),
  );
}

function stubFetchOk(): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true })));
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('PdfWidget (ADR-0052)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('compares on srcs, alt and rawUrl', () => {
    const widget = new PdfWidget(['a.pdf'], 'A', 'a.pdf');
    expect(widget.eq(new PdfWidget(['a.pdf'], 'A', 'a.pdf'))).toBe(true);
    expect(widget.eq(new PdfWidget(['b.pdf'], 'A', 'b.pdf'))).toBe(false);
    expect(widget.eq(new PdfWidget(['a.pdf'], 'B', 'a.pdf'))).toBe(false);
    expect(widget.eq(new PdfWidget(['a.pdf'], 'A', 'other'))).toBe(false);
  });

  it('shows the pending note first, then mounts the frame on a good probe', async () => {
    stubFetchOk();
    const opened: string[] = [];
    const span = new PdfWidget(['drey-asset://v1/asset/a.pdf'], 'Doc', 'a.pdf', (s) =>
      opened.push(s),
    ).toDOM();
    // `mount` bails on a detached node (the editor never shows one) —
    // attach like CodeMirror would.
    document.body.appendChild(span);
    try {
      expect(span.querySelector('.lp-pdf-pending')).not.toBeNull();
      await settle();
      expect(span.querySelector('.lp-pdf-pending')).toBeNull();
      const frame = span.querySelector('iframe');
      expect(frame?.getAttribute('src')).toBe('drey-asset://v1/asset/a.pdf');
      expect(span.querySelector('.lp-lens')).not.toBeNull();
    } finally {
      span.remove();
    }
  });

  it('mounts the error box naming the raw reference when every probe fails', async () => {
    stubFetchNeverOk();
    const span = new PdfWidget(['gone.pdf', 'gone2.pdf'], 'Doc', 'gone.pdf').toDOM();
    document.body.appendChild(span);
    try {
      await settle();
      expect(span.querySelector('iframe')).toBeNull();
      const error = span.querySelector('.lp-pdf-error');
      expect(error?.textContent).toBe('PDF not found: gone.pdf');
      expect(span.querySelector('.lp-tools')).not.toBeNull();
    } finally {
      span.remove();
    }
  });

  it('the lens hands over the probed candidate, and ignoreEvent follows the shared rule', async () => {
    stubFetchOk();
    const opened: string[] = [];
    const widget = new PdfWidget(['a.pdf'], 'A', 'a.pdf', (s) => opened.push(s));
    const span = widget.toDOM();
    document.body.appendChild(span);
    try {
      await settle();
      (span.querySelector('.lp-lens') as HTMLButtonElement).click();
      expect(opened).toEqual(['a.pdf']);
    } finally {
      span.remove();
    }

    const target = document.createElement('span');
    expect(widget.ignoreEvent({ target } as unknown as Event)).toBe(true);
    const edit = document.createElement('button');
    edit.className = 'lp-edit';
    expect(widget.ignoreEvent({ target: edit } as unknown as Event)).toBe(false);
    const miss = document.createElement('pre');
    miss.className = 'lp-pdf-error';
    expect(widget.ignoreEvent({ target: miss } as unknown as Event)).toBe(false);
  });
});

describe('PdfPreviewWidget (ADR-0052)', () => {
  it('mounts a bare frame of the first candidate, no probe and no chrome', () => {
    const widget = new PdfPreviewWidget(['a.pdf', 'b.pdf'], 'Doc');
    const span = widget.toDOM();
    expect(span.className).toBe('lp-pdf lp-pdf-preview');
    expect(span.querySelector('iframe')?.getAttribute('src')).toBe('a.pdf');
    expect(span.querySelector('.lp-tools')).toBeNull();
    expect(widget.eq(new PdfPreviewWidget(['a.pdf', 'b.pdf'], 'Doc'))).toBe(true);
    expect(widget.eq(new PdfPreviewWidget(['a.pdf'], 'Doc'))).toBe(false);
  });

  it('renders nothing (but stays a widget) when there is no candidate', () => {
    const span = new PdfPreviewWidget([], 'Doc').toDOM();
    expect(span.querySelector('iframe')).toBeNull();
  });
});
