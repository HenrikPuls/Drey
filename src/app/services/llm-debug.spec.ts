import {
  LlmDebugEntry,
  maskAuthorizationHeader,
  maskSecret,
  toCurl,
  truncate,
} from '../../../shared/llm';

function entry(patch: Partial<LlmDebugEntry> = {}): LlmDebugEntry {
  return {
    id: 1,
    at: '13:45:02.100',
    provider: 'lmstudio',
    method: 'POST',
    url: 'http://127.0.0.1:8888/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer sk-unslo…3456',
    },
    authSent: true,
    body: '{"model":"Bonsai-27B-GGUF"}',
    status: 401,
    durationMs: 12,
    responseBody: '{"error":"unauthorized"}',
    error: null,
    ...patch,
  };
}

describe('maskSecret', () => {
  it('keeps a recognisable prefix and suffix for a long key', () => {
    expect(maskSecret('sk-unsloth-ABCDEF123456')).toBe('sk-unslo…3456');
  });

  it('reveals almost nothing for short values', () => {
    expect(maskSecret('abc')).toBe('…');
    expect(maskSecret('abcdefgh')).toBe('abc…gh');
  });
});

describe('maskAuthorizationHeader', () => {
  it('masks only the token, keeping the scheme visible', () => {
    expect(maskAuthorizationHeader('Bearer sk-unsloth-ABCDEF123456')).toBe('Bearer sk-unslo…3456');
  });

  it('masks a non-bearer value whole (no scheme kept)', () => {
    expect(maskAuthorizationHeader('Basic QWxhZGRpbjpvcGVu')).toBe('Basic QW…cGVu');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('marks how much was cut', () => {
    expect(truncate('abcdefghij', 4)).toBe('abcd\n… [truncated, 10 chars total]');
  });
});

describe('toCurl', () => {
  it('rebuilds the request with masked headers by default', () => {
    const command = toCurl(entry());
    expect(command).toContain(`curl -X POST 'http://127.0.0.1:8888/v1/chat/completions'`);
    expect(command).toContain(`-H 'authorization: Bearer sk-unslo…3456'`);
    expect(command).toContain(`-d '{"model":"Bonsai-27B-GGUF"}'`);
  });

  it('substitutes the real key when one is handed in', () => {
    const command = toCurl(entry(), 'sk-unsloth-REAL');
    expect(command).toContain(`-H 'authorization: Bearer sk-unsloth-REAL'`);
    expect(command).not.toContain('…');
  });

  it('omits the body for a GET', () => {
    const command = toCurl(entry({ method: 'GET', body: null, url: 'http://x/v1/models' }));
    expect(command).toContain(`curl -X GET 'http://x/v1/models'`);
    expect(command).not.toContain('-d ');
  });

  it('escapes single quotes so the command stays runnable', () => {
    const command = toCurl(entry({ body: `{"q":"it's"}` }));
    expect(command).toContain(`-d '{"q":"it'\\''s"}'`);
  });
});
