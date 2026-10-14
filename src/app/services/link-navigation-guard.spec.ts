import { installLinkNavigationGuard, navigatesAway } from './link-navigation-guard';

describe('navigatesAway (bug-11)', () => {
  const here = 'http://localhost:4200/';

  it('is true for another path of the app origin', () => {
    expect(navigatesAway('09_architecture_decisions/0052-pdf.md', here)).toBe(true);
    expect(navigatesAway('/manual/manual.md', here)).toBe(true);
  });

  it('is false for an in-page anchor and for other origins', () => {
    expect(navigatesAway('#fn1', here)).toBe(false);
    expect(navigatesAway('http://localhost:4200/#section', here)).toBe(false);
    expect(navigatesAway('https://example.com/page', here)).toBe(false);
    expect(navigatesAway('mailto:someone@example.com', here)).toBe(false);
  });
});

describe('installLinkNavigationGuard', () => {
  let remove: () => void;
  let container: HTMLElement;

  beforeEach(() => {
    remove = installLinkNavigationGuard(window);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    remove();
    container.remove();
  });

  function clickLink(href: string): MouseEvent {
    container.innerHTML = `<a href="${href}"><span>label</span></a>`;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    container.querySelector('span')!.dispatchEvent(event);
    return event;
  }

  it('cancels a same-origin link to another page', () => {
    expect(clickLink('notes/other.md').defaultPrevented).toBe(true);
  });

  it('leaves in-page anchors and external links alone', () => {
    expect(clickLink('#top').defaultPrevented).toBe(false);
    expect(clickLink('https://example.com/').defaultPrevented).toBe(false);
  });
});
