import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Markdown } from './markdown';

const TEXT = '# Title\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [ ] one\n- [x] two\n\n==marked== and $x^2$\n';

async function settle(fixture: ComponentFixture<Markdown>): Promise<void> {
  for (let i = 0; i < 20; i++) {
    fixture.detectChanges();
    await fixture.whenStable();
    if ((fixture.nativeElement as HTMLElement).querySelector('.cm-editor') !== null) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  fixture.detectChanges();
}

function mount(inputs: Record<string, unknown>): ComponentFixture<Markdown> {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Markdown);
  for (const [key, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(key, value);
  }
  fixture.detectChanges();
  return fixture;
}

const buttons = (fixture: ComponentFixture<Markdown>): HTMLButtonElement[] =>
  Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.mdx-seg-btn'));

describe('the Markdown surface', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the text plainly until the CodeMirror chunk has loaded, then mounts the engine', async () => {
    const fixture = mount({ text: TEXT, surface: 'spec-a' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.mdx-plain')?.textContent).toContain('# Title');
    await settle(fixture);
    expect(el.querySelector('.cm-editor')).not.toBeNull();
    expect(el.querySelector('.mdx-plain')).toBeNull();
  });

  it('opens in View by default and View is read-only', async () => {
    const fixture = mount({ text: TEXT, surface: 'spec-b' });
    await settle(fixture);
    const pressed = buttons(fixture).filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((b) => b.textContent?.trim())).toEqual(['View']);
    const content = (fixture.nativeElement as HTMLElement).querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('false');
  });

  it('opens in Live Preview where the owner writes, and the strip shows only then', async () => {
    const fixture = mount({ text: TEXT, surface: 'spec-c', defaultMode: 'live', editable: true });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(buttons(fixture).find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent?.trim()).toBe('Live');
    expect(el.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true');
    expect(el.querySelectorAll('.mdx-fmt').length).toBeGreaterThan(0);
    buttons(fixture)[1]!.click();
    fixture.detectChanges();
    expect(el.querySelector('.mdx-strip')).toBeNull();
  });

  it('remembers the pick per surface and shows the raw Markdown in Source', async () => {
    const first = mount({ text: TEXT, surface: 'spec-d' });
    await settle(first);
    buttons(first)[2]!.click();
    first.detectChanges();
    expect(localStorage.getItem('mc.md-mode.spec-d')).toBe('source');
    expect((first.nativeElement as HTMLElement).querySelector('.cm-content')?.textContent).toContain('| a | b |');
    first.destroy();

    const second = mount({ text: TEXT, surface: 'spec-d' });
    await settle(second);
    expect(buttons(second).find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent?.trim()).toBe('Source');
  });

  it('follows the bound text without losing the view', async () => {
    const fixture = mount({ text: 'one', surface: 'spec-e' });
    await settle(fixture);
    fixture.componentRef.setInput('text', 'one\n\ntwo');
    fixture.detectChanges();
    await fixture.whenStable();
    expect((fixture.nativeElement as HTMLElement).querySelector('.cm-content')?.textContent).toContain('two');
  });
});
