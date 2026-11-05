import { describe, expect, it } from 'vitest';
import { trackVisualViewport, viewportVarsOf, type ViewportHost } from './viewport';

describe('viewportVarsOf (D-7d)', () => {
  it('is silent at full height, so the stylesheet fallbacks stay in charge', () => {
    expect(viewportVarsOf({ height: 844, offsetTop: 0 }, 844)).toEqual({ vh: null, top: null });
  });

  it('follows the visual viewport when the keyboard has shrunk it', () => {
    expect(viewportVarsOf({ height: 508.4, offsetTop: 0 }, 844)).toEqual({ vh: '508px', top: '0px' });
  });

  it('carries the pan iOS adds to reveal the focused field, never a negative one', () => {
    expect(viewportVarsOf({ height: 508, offsetTop: 120.6 }, 844)).toEqual({ vh: '508px', top: '121px' });
    expect(viewportVarsOf({ height: 508, offsetTop: -3 }, 844)).toEqual({ vh: '508px', top: '0px' });
  });
});

describe('trackVisualViewport (D-7d)', () => {
  function fakeHost() {
    const props = new Map<string, string>();
    const scrolls: number[][] = [];
    const listeners = new Map<string, () => void>();
    const viewport = {
      height: 844,
      offsetTop: 0,
      addEventListener: (type: string, listener: unknown) => void listeners.set(type, listener as () => void),
      fire: (type: string) => listeners.get(type)?.(),
    };
    const host = {
      innerHeight: 844,
      document: {
        documentElement: {
          style: {
            setProperty: (name: string, value: string) => void props.set(name, value),
            removeProperty: (name: string) => {
              props.delete(name);
              return '';
            },
          },
        },
      },
      visualViewport: viewport,
      scrollTo: (x: number, y: number) => void scrolls.push([x, y]),
    } as unknown as ViewportHost;
    return { host, props, viewport, scrolls };
  }

  it('shrinks the frame while the keyboard is up and restores it afterwards', () => {
    const { host, props, viewport, scrolls } = fakeHost();
    trackVisualViewport(host);
    expect(props.size).toBe(0);

    viewport.height = 500;
    viewport.offsetTop = 90;
    viewport.fire('resize');
    expect(props.get('--mc-vh')).toBe('500px');
    expect(props.get('--mc-vv-top')).toBe('90px');
    expect(scrolls).toEqual([[0, 0]]);

    viewport.offsetTop = 0;
    viewport.fire('scroll');
    expect(props.get('--mc-vv-top')).toBe('0px');

    viewport.height = 844;
    viewport.fire('resize');
    expect(props.size).toBe(0);
  });

  it('does nothing without a visual viewport', () => {
    const { host, props } = fakeHost();
    expect(() => trackVisualViewport({ ...host, visualViewport: null })).not.toThrow();
    expect(props.size).toBe(0);
  });
});
