import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { DreyApi } from '../../../shared/ipc-api';
import { PaneDropService } from './pane-drop.service';
import { PaneLeaf } from './pane-leaf';

/** A bubbling, cancelable `drop` with a fake `dataTransfer`. */
function dropEvent(types: string[]): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, getData: () => '', files: [] as unknown as FileList },
  });
  return event;
}

describe('PaneLeaf file drop', () => {
  let fixture: ComponentFixture<PaneLeaf>;
  let paneDrop: PaneDropService;

  beforeEach(() => {
    window.dreyApi = { listTags: () => Promise.resolve([]) } as unknown as DreyApi;
    TestBed.configureTestingModule({ imports: [PaneLeaf] });
    paneDrop = TestBed.inject(PaneDropService);
    fixture = TestBed.createComponent(PaneLeaf);
    fixture.componentRef.setInput('paneId', 'p1');
    fixture.detectChanges();
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
  });

  it('delegates a vault-file drop on the pane body to PaneDropService', () => {
    const open = vi.spyOn(paneDrop, 'openFromDrop').mockResolvedValue(true);
    const host = fixture.nativeElement as HTMLElement;

    host.dispatchEvent(dropEvent(['application/x-drey-vault-path']));

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('p1', expect.anything());
  });

  it('leaves a drop that lands on .cm-content to CodeMirror', () => {
    const open = vi.spyOn(paneDrop, 'openFromDrop').mockResolvedValue(true);
    const host = fixture.nativeElement as HTMLElement;
    const cmContent = document.createElement('div');
    cmContent.className = 'cm-content';
    host.appendChild(cmContent);

    cmContent.dispatchEvent(dropEvent(['application/x-drey-vault-path']));

    expect(open).not.toHaveBeenCalled();
  });
});
