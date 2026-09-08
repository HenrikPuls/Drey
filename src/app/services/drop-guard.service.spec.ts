import { TestBed } from '@angular/core/testing';
import { DropGuardService } from './drop-guard.service';

/** A cancelable drag event with a fake `dataTransfer` carrying `types`. */
function dragEvent(name: 'dragover' | 'drop', types: string[]): Event {
  const event = new Event(name, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types } });
  return event;
}

describe('DropGuardService', () => {
  let plain: HTMLDivElement;
  let editable: HTMLInputElement;
  let cmContent: HTMLDivElement;

  beforeEach(() => {
    TestBed.inject(DropGuardService); // installs the window listeners

    plain = document.createElement('div');
    editable = document.createElement('input');
    cmContent = document.createElement('div');
    cmContent.className = 'cm-content';
    document.body.append(plain, editable, cmContent);
  });

  afterEach(() => {
    plain.remove();
    editable.remove();
    cmContent.remove();
  });

  it('prevents a file drop on ordinary chrome', () => {
    const event = dragEvent('drop', ['Files']);
    plain.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a drop on the editor / a native field alone', () => {
    const onEditor = dragEvent('drop', ['Files']);
    cmContent.dispatchEvent(onEditor);
    expect(onEditor.defaultPrevented).toBe(false);

    const onInput = dragEvent('drop', ['Files']);
    editable.dispatchEvent(onInput);
    expect(onInput.defaultPrevented).toBe(false);
  });

  it('marks chrome as a drop target on dragover only for a drag it would handle', () => {
    const files = dragEvent('dragover', ['Files']);
    plain.dispatchEvent(files);
    expect(files.defaultPrevented).toBe(true);

    const vaultPath = dragEvent('dragover', ['application/x-drey-vault-path']);
    plain.dispatchEvent(vaultPath);
    expect(vaultPath.defaultPrevented).toBe(true);

    const uninteresting = dragEvent('dragover', ['text/x-moz-place']);
    plain.dispatchEvent(uninteresting);
    expect(uninteresting.defaultPrevented).toBe(false);
  });
});
