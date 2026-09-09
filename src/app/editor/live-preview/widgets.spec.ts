import { ImageWidget, svgToDataUrl } from './widgets';

describe('ImageWidget', () => {
  it('renders an <img> with the resolved src and alt', () => {
    const dom = new ImageWidget('drey-asset://asset/pic.png', 'a boat').toDOM();
    expect(dom.className).toBe('lp-image');
    const img = dom.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('drey-asset://asset/pic.png');
    expect(img.getAttribute('alt')).toBe('a boat');
    expect(img.style.width).toBe('');
    expect(img.style.height).toBe('');
  });

  it('applies an explicit width / height in px', () => {
    const w = new ImageWidget('drey-asset://asset/pic.png', 'x', 300).toDOM().querySelector('img')!;
    expect(w.style.width).toBe('300px');
    expect(w.style.height).toBe('');

    const wh = new ImageWidget('drey-asset://asset/pic.png', 'x', 300, 200)
      .toDOM()
      .querySelector('img')!;
    expect(wh.style.width).toBe('300px');
    expect(wh.style.height).toBe('200px');
  });

  it('renders only the placeholder when the src could not be resolved', () => {
    const dom = new ImageWidget(null, 'gone', 300).toDOM();
    expect(dom.querySelector('img')).toBeNull();
    expect(dom.querySelector('.lp-image-missing')?.textContent).toContain('gone');
  });

  it('eq compares src, alt, width and height', () => {
    const base = new ImageWidget('s', 'a', 100, 50);
    expect(base.eq(new ImageWidget('s', 'a', 100, 50))).toBe(true);
    expect(base.eq(new ImageWidget('s', 'a', 120, 50))).toBe(false);
    expect(base.eq(new ImageWidget('s', 'a', 100, null))).toBe(false);
    expect(base.eq(new ImageWidget('s2', 'a', 100, 50))).toBe(false);
    expect(base.eq(new ImageWidget('s', 'b', 100, 50))).toBe(false);
  });

  it('falls back to the placeholder on a runtime load error', () => {
    const dom = new ImageWidget('drey-asset://asset/pic.png', 'boat').toDOM();
    const img = dom.querySelector('img')!;
    img.onerror!(new Event('error'));
    expect(dom.querySelector('img')).toBeNull();
    expect(dom.querySelector('.lp-image-missing')).not.toBeNull();
  });

  describe('lens button', () => {
    it('is absent without an onOpenImage callback', () => {
      expect(
        new ImageWidget('drey-asset://asset/pic.png', 'x').toDOM().querySelector('.lp-lens'),
      ).toBeNull();
    });

    it('is absent when the src could not be resolved', () => {
      const dom = new ImageWidget(null, 'x', null, null, () => undefined).toDOM();
      expect(dom.querySelector('.lp-lens')).toBeNull();
    });

    it('calls onOpenImage with the resolved src, and stops the event', () => {
      const opened: string[] = [];
      const dom = new ImageWidget('drey-asset://asset/pic.png', 'x', null, null, (s) =>
        opened.push(s),
      ).toDOM();
      const lens = dom.querySelector('.lp-lens') as HTMLButtonElement;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      lens.dispatchEvent(event);
      expect(opened).toEqual(['drey-asset://asset/pic.png']);
      expect(event.defaultPrevented).toBe(true);
    });

    it('is removed alongside the img on a load error', () => {
      const dom = new ImageWidget('drey-asset://asset/pic.png', 'x', null, null, () =>
        undefined,
      ).toDOM();
      dom.querySelector('img')!.onerror!(new Event('error'));
      expect(dom.querySelector('.lp-lens')).toBeNull();
      expect(dom.querySelector('.lp-image-missing')).not.toBeNull();
    });
  });

  describe('svgToDataUrl (mermaid zoom)', () => {
    it('promotes a viewBox to explicit width/height and drops max-width', () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480" ' +
        'style="max-width: 640px; background: white;"><rect width="10" height="10"/></svg>';
      const url = svgToDataUrl(svg);
      expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
      const decoded = decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length));
      expect(decoded).toContain('width="640"');
      expect(decoded).toContain('height="480"');
      expect(decoded).not.toContain('max-width');
    });

    it('still returns a usable data URL when there is no viewBox', () => {
      const url = svgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>');
      expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    });

    it('falls back to the raw markup for non-SVG input', () => {
      const url = svgToDataUrl('not svg at all');
      expect(url).toBe('data:image/svg+xml;charset=utf-8,not%20svg%20at%20all');
    });
  });

  describe('resize grip', () => {
    it('is present for a resolved image and gone for the placeholder / on error', () => {
      expect(
        new ImageWidget('drey-asset://asset/p.png', 'x').toDOM().querySelector('.lp-resize'),
      ).not.toBeNull();
      expect(new ImageWidget(null, 'x').toDOM().querySelector('.lp-resize')).toBeNull();

      const dom = new ImageWidget('drey-asset://asset/p.png', 'x').toDOM();
      dom.querySelector('img')!.onerror!(new Event('error'));
      expect(dom.querySelector('.lp-resize')).toBeNull();
    });

    it('ignoreEvent lets CodeMirror see only .lp-resize events', () => {
      const w = new ImageWidget('drey-asset://asset/p.png', 'x');
      const dom = w.toDOM();
      const grip = dom.querySelector('.lp-resize')!;
      const img = dom.querySelector('img')!;

      const onGrip = new MouseEvent('pointerdown');
      Object.defineProperty(onGrip, 'target', { value: grip });
      expect(w.ignoreEvent(onGrip)).toBe(false);

      const onImg = new MouseEvent('pointerdown');
      Object.defineProperty(onImg, 'target', { value: img });
      expect(w.ignoreEvent(onImg)).toBe(true);
    });
  });
});
