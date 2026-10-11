import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, isAppDocument } from './content-security-policy';

function directive(policy: string, name: string): string[] {
  const found = policy.split('; ').find((part) => part.startsWith(`${name} `));
  return found === undefined ? [] : found.split(' ').slice(1);
}

describe('buildContentSecurityPolicy', () => {
  it('allows scripts only from the app bundle and plugin directories', () => {
    const policy = buildContentSecurityPolicy();
    expect(directive(policy, 'script-src')).toEqual(["'self'", 'plugin:']);
    expect(policy).not.toContain('unsafe-eval');
  });

  it('denies everything that has no directive of its own', () => {
    const policy = buildContentSecurityPolicy();
    expect(directive(policy, 'default-src')).toEqual(["'none'"]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'form-action')).toEqual(["'none'"]);
  });

  it('allows inline styles but never inline scripts', () => {
    const policy = buildContentSecurityPolicy();
    expect(directive(policy, 'style-src')).toContain("'unsafe-inline'");
    expect(directive(policy, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('frames only vault files and plugin pages', () => {
    expect(directive(buildContentSecurityPolicy(), 'frame-src')).toEqual(['plugin:', 'drey-asset:']);
  });

  it('connects to local schemes only outside a dev run', () => {
    expect(directive(buildContentSecurityPolicy(), 'connect-src')).toEqual([
      "'self'",
      'plugin:',
      'drey-asset:',
    ]);
  });

  it('adds the dev server socket in a dev run and nothing else', () => {
    const policy = buildContentSecurityPolicy('http://localhost:4200');
    expect(directive(policy, 'connect-src')).toEqual([
      "'self'",
      'plugin:',
      'drey-asset:',
      'ws://localhost:4200',
    ]);
    expect(directive(policy, 'script-src')).toEqual(["'self'", 'plugin:']);
  });
});

describe('isAppDocument', () => {
  it('matches the page and leaves out the splash and other files', () => {
    expect(isAppDocument('/')).toBe(true);
    expect(isAppDocument('/index.html')).toBe(true);
    expect(isAppDocument('/splash.html')).toBe(false);
    expect(isAppDocument('/main-ABCDEFGH.js')).toBe(false);
    expect(isAppDocument('/assets/licenses.json')).toBe(false);
  });
});
