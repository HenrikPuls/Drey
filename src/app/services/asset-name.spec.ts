import { assetFileName, assetTimestamp, ATTACHMENTS_DIR, imageExtension } from '../../../shared/asset-name';

describe('imageExtension', () => {
  it('maps the common image MIME types', () => {
    expect(imageExtension('image/png')).toBe('png');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/gif')).toBe('gif');
    expect(imageExtension('image/webp')).toBe('webp');
    expect(imageExtension('image/svg+xml')).toBe('svg');
    expect(imageExtension('image/x-icon')).toBe('ico');
  });

  it('is case-insensitive and trims', () => {
    expect(imageExtension('  IMAGE/PNG ')).toBe('png');
  });

  it('falls back to a dropped file name extension', () => {
    expect(imageExtension('Screenshot 2026.PNG')).toBe('png');
    expect(imageExtension('diagram.jpeg')).toBe('jpg');
    expect(imageExtension('photo.tiff')).toBe('tif');
  });

  it('rejects non-image types and bare names', () => {
    expect(imageExtension('text/plain')).toBeNull();
    expect(imageExtension('application/pdf')).toBeNull();
    expect(imageExtension('notes.txt')).toBeNull();
    expect(imageExtension('')).toBeNull();
    expect(imageExtension('clipboard')).toBeNull();
  });
});

describe('assetTimestamp', () => {
  it('formats local time as YYYY-MM-DD-HHmmss with zero padding', () => {
    expect(assetTimestamp(new Date(2026, 0, 5, 9, 3, 7))).toBe('2026-01-05-090307');
    expect(assetTimestamp(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31-235959');
  });
});

describe('assetFileName', () => {
  const date = new Date(2026, 8, 8, 14, 35, 12);

  it('joins the timestamp, a 6-hex hash prefix and the extension', () => {
    expect(assetFileName({ date, hashHex: 'a1b2c3d4e5f6deadbeef', ext: 'png' })).toBe(
      '2026-09-08-143512-a1b2c3.png',
    );
  });

  it('normalises a leading dot and upper-case in the extension', () => {
    expect(assetFileName({ date, hashHex: 'ffffff00', ext: '.JPG' })).toBe(
      '2026-09-08-143512-ffffff.jpg',
    );
  });

  it('throws on a malformed extension', () => {
    expect(() => assetFileName({ date, hashHex: 'abcdef', ext: 'p g' })).toThrow();
    expect(() => assetFileName({ date, hashHex: 'abcdef', ext: '' })).toThrow();
  });

  it('throws when there is not enough hash to take 6 hex digits', () => {
    expect(() => assetFileName({ date, hashHex: 'abc', ext: 'png' })).toThrow();
    expect(() => assetFileName({ date, hashHex: 'zzzzzz', ext: 'png' })).toThrow();
  });
});

describe('ATTACHMENTS_DIR', () => {
  it('is the conventional folder name', () => {
    expect(ATTACHMENTS_DIR).toBe('attachments');
  });
});
