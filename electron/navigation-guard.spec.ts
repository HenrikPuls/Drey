import { describe, expect, it } from 'vitest';
import { isAllowedNavigation } from './navigation-guard';

describe('isAllowedNavigation (bug-11)', () => {
  it('allows the app entry on its own origin (dev server and app://)', () => {
    expect(isAllowedNavigation('http://localhost:4200/', 'http://localhost:4200')).toBe(true);
    expect(isAllowedNavigation('http://localhost:4200', 'http://localhost:4200')).toBe(true);
    expect(isAllowedNavigation('http://localhost:4200/?x=1#y', 'http://localhost:4200')).toBe(true);
    expect(isAllowedNavigation('app://app/index.html', 'app://app')).toBe(true);
  });

  it('refuses another path of the same origin — a relative note link', () => {
    expect(
      isAllowedNavigation(
        'http://localhost:4200/09_architecture_decisions/0052-pdf-embeds-and-viewer.md',
        'http://localhost:4200',
      ),
    ).toBe(false);
    expect(isAllowedNavigation('app://app/notes/other.md', 'app://app')).toBe(false);
  });

  it('refuses other origins and schemes', () => {
    expect(isAllowedNavigation('https://example.com/', 'http://localhost:4200')).toBe(false);
    expect(isAllowedNavigation('file:///C:/notes/a.md', 'app://app')).toBe(false);
    expect(isAllowedNavigation('http://localhost:4201/', 'http://localhost:4200')).toBe(false);
    expect(isAllowedNavigation('not a url', 'app://app')).toBe(false);
  });
});
