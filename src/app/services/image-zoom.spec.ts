import {
  clampImageScale,
  fitScale,
  IMAGE_SCALE_MAX,
  IMAGE_SCALE_MIN,
  zoomToward,
} from '../../../shared/image-zoom';

describe('clampImageScale', () => {
  it('bounds to [MIN, MAX] and snaps to a 0.01 grid', () => {
    expect(clampImageScale(0.001)).toBe(IMAGE_SCALE_MIN);
    expect(clampImageScale(99)).toBe(IMAGE_SCALE_MAX);
    expect(clampImageScale(1.23456)).toBe(1.23);
  });

  it('falls back to 1 for non-finite input', () => {
    expect(clampImageScale(Number.NaN)).toBe(1);
    expect(clampImageScale(undefined)).toBe(1);
    expect(clampImageScale('2')).toBe(1);
  });
});

describe('zoomToward', () => {
  const center = { x: 400, y: 300 };

  it('keeps scale and offset centred when the cursor is at the stage centre', () => {
    const vp = { scale: 1, offsetX: 0, offsetY: 0 };
    const next = zoomToward(vp, center, center, 2);
    expect(next.scale).toBe(2);
    expect(next.offsetX).toBeCloseTo(0, 6);
    expect(next.offsetY).toBeCloseTo(0, 6);
  });

  it('holds the image-space point under an off-centre cursor fixed', () => {
    const vp = { scale: 1, offsetX: 0, offsetY: 0 };
    const cursor = { x: 600, y: 300 }; // 200px right of centre
    const next = zoomToward(vp, cursor, center, 2);
    // point under the cursor before: (cursor - center - offset)/scale = (200,0)
    // after: (cursor - center - offset')/scale' must still be (200,0)
    const px = (cursor.x - center.x - next.offsetX) / next.scale;
    const py = (cursor.y - center.y - next.offsetY) / next.scale;
    expect(px).toBeCloseTo(200, 6);
    expect(py).toBeCloseTo(0, 6);
  });

  it('clamps the scale and keeps the offset consistent with the clamped value', () => {
    const vp = { scale: IMAGE_SCALE_MAX, offsetX: 10, offsetY: -10 };
    const cursor = { x: 500, y: 250 };
    const next = zoomToward(vp, cursor, center, 4);
    expect(next.scale).toBe(IMAGE_SCALE_MAX);
    const px = (cursor.x - center.x - next.offsetX) / next.scale;
    const pxBefore = (cursor.x - center.x - vp.offsetX) / vp.scale;
    expect(px).toBeCloseTo(pxBefore, 6);
  });
});

describe('fitScale', () => {
  it('scales a wide image down to the box width', () => {
    expect(fitScale({ w: 4000, h: 2000 }, { w: 800, h: 600 })).toBe(0.2);
  });

  it('never upscales a small image past 100%', () => {
    expect(fitScale({ w: 200, h: 100 }, { w: 800, h: 600 })).toBe(1);
  });

  it('fits to width only; a tall image overflows the stage vertically', () => {
    // Old behaviour fit the height (0.2); now only the width ratio counts.
    expect(fitScale({ w: 1000, h: 4000 }, { w: 800, h: 800 })).toBe(0.8);
  });

  it('returns 1 for a zero / unknown natural size or box', () => {
    expect(fitScale({ w: 0, h: 0 }, { w: 800, h: 600 })).toBe(1);
    expect(fitScale({ w: 100, h: 100 }, { w: 0, h: 0 })).toBe(1);
  });
});
