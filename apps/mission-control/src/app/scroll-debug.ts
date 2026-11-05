/**
 * D-5b — `?debug=scroll`: an opt-in recorder for "the page moves and I do not know
 * why". It samples everything that can move the frame (document scroll, the
 * visual viewport's offset, pan and zoom, the body box, the top and bottom of the
 * bars), logs every difference from the previous sample with a timestamp and the
 * event that was running, and shows the last lines on screen with a Copy button,
 * so the owner can turn it on on the phone and send back what moved. Nothing is
 * stored or sent anywhere.
 */

export interface ScrollSample {
  readonly values: Readonly<Record<string, number>>;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** The lines (`name a → b`) of every value that differs between two samples; empty = nothing moved. */
export function changesOf(before: ScrollSample, now: ScrollSample): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(now.values)) {
    const was = before.values[name];
    if (was !== undefined && Math.abs(was - value) > 0.01) {
      out.push(`${name} ${round(was)} → ${round(value)}`);
    }
  }
  return out;
}

/** The bars whose position must never change. */
const CHROME: readonly string[] = ['.shell', '.hdr', '.phonebar', '.tabbar', '.composer', 'mc-root'];

export function sampleOf(win: Window): ScrollSample {
  const values: Record<string, number> = { scrollY: win.scrollY, scrollX: win.scrollX, innerHeight: win.innerHeight };
  const vv = win.visualViewport;
  if (vv !== null) {
    values['vv.offsetTop'] = vv.offsetTop;
    values['vv.pageTop'] = vv.pageTop;
    values['vv.offsetLeft'] = vv.offsetLeft;
    values['vv.height'] = vv.height;
    values['vv.scale'] = vv.scale;
  }
  const body = win.document.body.getBoundingClientRect();
  values['body.top'] = body.top;
  values['body.height'] = body.height;
  for (const selector of CHROME) {
    const el = win.document.querySelector(selector);
    if (el !== null) {
      const rect = el.getBoundingClientRect();
      values[`${selector}.top`] = rect.top;
      values[`${selector}.bottom`] = rect.bottom;
    }
  }
  return { values };
}

const EVENTS = ['scroll', 'resize', 'touchstart', 'touchmove', 'touchend', 'focusin', 'focusout', 'orientationchange', 'pageshow'];

export function installScrollDebug(win: Window): void {
  const doc = win.document;
  const lines: string[] = [];
  const started = win.performance.now();
  let last = sampleOf(win);
  let trigger = 'start';

  const panel = doc.createElement('div');
  panel.style.cssText =
    'position:fixed;left:0;right:0;top:0;z-index:2147483647;pointer-events:none;font:10px/1.3 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,.72);padding:2px 4px;white-space:pre-wrap';
  const text = doc.createElement('div');
  const copy = doc.createElement('button');
  copy.textContent = 'copy log';
  copy.style.cssText = 'pointer-events:auto;font:10px monospace;margin-top:2px';
  copy.addEventListener('click', () => {
    void win.navigator.clipboard?.writeText(lines.join('\n'));
  });
  panel.append(text, copy);
  doc.body.append(panel);

  const render = (): void => {
    const v = last.values;
    text.textContent =
      `scrollY ${round(v['scrollY'] ?? 0)}  vv.top ${round(v['vv.offsetTop'] ?? 0)}  vv.pageTop ${round(v['vv.pageTop'] ?? 0)}  ` +
      `scale ${round(v['vv.scale'] ?? 1)}  vv.h ${round(v['vv.height'] ?? 0)}  inner.h ${round(v['innerHeight'] ?? 0)}  ` +
      `body ${round(v['body.top'] ?? 0)}/${round(v['body.height'] ?? 0)}\n` +
      lines.slice(-6).join('\n');
  };

  const check = (): void => {
    const now = sampleOf(win);
    const changes = changesOf(last, now);
    if (changes.length > 0) {
      lines.push(`${Math.round(win.performance.now() - started)}ms [${trigger}] ${changes.join(', ')}`);
      (win as unknown as { __mcScrollLog: string[] }).__mcScrollLog = lines;
    }
    last = now;
    render();
  };
  for (const type of EVENTS) {
    win.addEventListener(
      type,
      () => {
        trigger = type;
        check();
      },
      { passive: true, capture: true },
    );
  }
  win.visualViewport?.addEventListener('resize', () => {
    trigger = 'vv.resize';
    check();
  });
  win.visualViewport?.addEventListener('scroll', () => {
    trigger = 'vv.scroll';
    check();
  });
  win.setInterval(() => {
    trigger = 'tick';
    check();
  }, 250);
  render();
}
