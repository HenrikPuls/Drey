import { normalizeAddress } from './normalize-address';

describe('normalizeAddress (browser plugin)', () => {
  it('passes through an existing http(s) URL', () => {
    expect(normalizeAddress('https://x.dev')).toBe('https://x.dev');
    expect(normalizeAddress('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
    expect(normalizeAddress('  https://x.dev  ')).toBe('https://x.dev');
  });

  it('passes through about: URLs', () => {
    expect(normalizeAddress('about:blank')).toBe('about:blank');
  });

  it('https-prefixes a bare host', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com');
    expect(normalizeAddress('sub.example.co.uk/p?q=1')).toBe('https://sub.example.co.uk/p?q=1');
  });

  it('https-prefixes localhost and IPv4 with a port / path', () => {
    expect(normalizeAddress('localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeAddress('127.0.0.1')).toBe('https://127.0.0.1');
    expect(normalizeAddress('192.168.1.5:8080/x')).toBe('https://192.168.1.5:8080/x');
  });

  it('upgrades a protocol-relative URL', () => {
    expect(normalizeAddress('//example.com/a')).toBe('https://example.com/a');
  });

  it('searches for free text', () => {
    expect(normalizeAddress('hello world')).toBe('https://duckduckgo.com/?q=hello%20world');
    expect(normalizeAddress('what is rust')).toBe('https://duckduckgo.com/?q=what%20is%20rust');
    // A single bare word is not a host (no dot) -> search.
    expect(normalizeAddress('test')).toBe('https://duckduckgo.com/?q=test');
  });

  it('never navigates to a non-http scheme -- searches instead', () => {
    expect(normalizeAddress('file:///c:/x')).toBe('https://duckduckgo.com/?q=file%3A%2F%2F%2Fc%3A%2Fx');
    expect(normalizeAddress('javascript:alert(1)')).toBe(
      'https://duckduckgo.com/?q=javascript%3Aalert(1)',
    );
  });

  it('returns empty for empty input', () => {
    expect(normalizeAddress('')).toBe('');
    expect(normalizeAddress('   ')).toBe('');
  });
});
