import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { UpdateService } from '../services/update.service';
import { KeybindingService } from '../keybindings';
import { StatusItemsService } from '../plugin-host';
import { StatusBar } from './status-bar';

describe('StatusBar', () => {
  let fixture: ComponentFixture<StatusBar>;
  let editor: EditorService;
  let el: HTMLElement;

  beforeEach(async () => {
    window.dreyApi = {
      readVaultFile: () => Promise.resolve({ content: 'one two three', modifiedMs: 1 }),
      getUpdateStatus: () => Promise.resolve(null),
      onUpdateStatusChanged: () => () => undefined,
    } as unknown as DreyApi;
    await TestBed.configureTestingModule({ imports: [StatusBar] }).compileComponents();
    editor = TestBed.inject(EditorService);
    fixture = TestBed.createComponent(StatusBar);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('shows word / char counts for a text document', async () => {
    await editor.openFile('note.md');
    fixture.detectChanges();
    expect(el.textContent).toContain('3 words');
    expect(el.textContent).toContain('13 chars');
  });

  it('shows pixel size + zoom for an image tab', async () => {
    await editor.openFile('shot.png');
    editor.setImageViewport({ naturalWidth: 1024, naturalHeight: 768, scale: 1.5 });
    fixture.detectChanges();

    expect(el.textContent).toContain('1024 × 768 · 150%');
    expect(el.textContent).not.toContain('words');
  });

  it('shows a dash before the image viewport is known', async () => {
    await editor.openFile('shot.png');
    editor.setImageViewport(null);
    fixture.detectChanges();
    expect(el.querySelector('.count')?.textContent?.trim()).toBe('—');
  });

  it('shows the transient update note as inline text (req-45)', () => {
    TestBed.inject(UpdateService).notice.set(
      'The latest version (Drey 0.7.0) is already installed.',
    );
    fixture.detectChanges();
    const note = el.querySelector('.update-note');
    expect(note?.textContent?.trim()).toContain('already installed');
  });

  it('shows no update note by default', () => {
    fixture.detectChanges();
    expect(el.querySelector('.update-note')).toBeNull();
  });

  it('renders plugin status items in priority order and runs the command on click', () => {
    const run = vi.spyOn(TestBed.inject(KeybindingService), 'run').mockReturnValue(undefined as never);
    const items = TestBed.inject(StatusItemsService);
    items.create({ text: 'low', priority: 1 });
    items.create({ text: 'high', tooltip: 'tip', commandId: 'x.open', priority: 9 });
    fixture.detectChanges();
    const slots = Array.from(el.querySelectorAll('.slot'));
    expect(slots.map((s) => s.textContent?.trim())).toEqual(['high', 'low']);
    expect(slots[0].getAttribute('title')).toBe('tip');
    expect(slots[1].tagName).toBe('SPAN');
    (slots[0] as HTMLButtonElement).click();
    expect(run).toHaveBeenCalledWith('x.open');
  });

  it('draws the optional dot of a status item (SDK 1.46)', () => {
    const items = TestBed.inject(StatusItemsService);
    items.create({ text: '3 need you', dot: 'attention' });
    items.create({ text: 'Autopilot · On', dot: 'positive' });
    items.create({ text: 'plain' });
    fixture.detectChanges();
    const slots = Array.from(el.querySelectorAll('.slot'));
    expect(slots[0].querySelector('.slot-dot.dot-attention')).not.toBeNull();
    expect(slots[1].querySelector('.slot-dot.dot-positive')).not.toBeNull();
    expect(slots[2].querySelector('.slot-dot')).toBeNull();
  });

  it('marks an item that opens a popup, and lights it while it is open (SDK 1.49)', () => {
    const items = TestBed.inject(StatusItemsService);
    const popup = items.create({ text: 'Autopilot · On', commandId: 'x.open', expanded: false, priority: 2 });
    items.create({ text: 'plain', commandId: 'x.run', priority: 1 });
    fixture.detectChanges();
    const [item, plain] = Array.from(el.querySelectorAll('.slot'));
    expect(item.getAttribute('aria-haspopup')).toBe('dialog');
    expect(item.getAttribute('aria-expanded')).toBe('false');
    expect(item.classList.contains('slot-open')).toBe(false);
    expect(plain.hasAttribute('aria-haspopup')).toBe(false);
    expect(plain.hasAttribute('aria-expanded')).toBe(false);
    popup.update({ expanded: true });
    fixture.detectChanges();
    expect(item.getAttribute('aria-expanded')).toBe('true');
    expect(item.classList.contains('slot-open')).toBe(true);
  });

  it('hands a plugin its item on screen, and null while it is hidden (SDK 1.49)', () => {
    const items = TestBed.inject(StatusItemsService);
    const handle = items.create({ text: 'Autopilot · On', commandId: 'x.open' });
    document.body.append(el);
    fixture.detectChanges();
    expect(handle.element()).toBe(el.querySelector('.slot'));
    handle.update({ text: '' });
    fixture.detectChanges();
    expect(handle.element()).toBeNull();
    el.remove();
  });
});
