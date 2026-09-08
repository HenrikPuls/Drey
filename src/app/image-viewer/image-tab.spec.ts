import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DreyApi } from '../../../shared/ipc-api';
import { EditorService } from '../services/editor.service';
import { ImageLightboxService } from './image-lightbox.service';
import { ImageTab } from './image-tab';

describe('ImageTab', () => {
  let fixture: ComponentFixture<ImageTab>;
  let editor: EditorService;
  let lightbox: ImageLightboxService;
  let el: HTMLElement;

  beforeEach(async () => {
    window.dreyApi = { readVaultFile: () => Promise.reject(new Error('not text')) } as unknown as DreyApi;
    await TestBed.configureTestingModule({ imports: [ImageTab] }).compileComponents();
    editor = TestBed.inject(EditorService);
    lightbox = TestBed.inject(ImageLightboxService);
    await editor.openFile('sub/dir/shot.png');

    fixture = TestBed.createComponent(ImageTab);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    delete (window as { dreyApi?: unknown }).dreyApi;
    localStorage.removeItem('drey.editor');
  });

  it('renders the viewer with the vault-root-relative drey-asset URL', () => {
    const img = el.querySelector('app-image-viewer img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('drey-asset://asset/sub/dir/shot.png');
    expect(el.querySelector('.meta .path')?.textContent).toContain('sub/dir/shot.png');
    expect(el.querySelector('.meta .zoom')?.textContent).toContain('%');
  });

  it('Fullscreen opens the lightbox with the same URL', () => {
    (el.querySelector('.meta .fs') as HTMLButtonElement).click();
    expect(lightbox.src()).toBe('drey-asset://asset/sub/dir/shot.png');
  });

  it('mirrors the viewer viewport into EditorService and clears it on destroy', () => {
    const img = el.querySelector('app-image-viewer img') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1024, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 768, configurable: true });
    img.dispatchEvent(new Event('load'));
    fixture.detectChanges();

    expect(editor.imageViewport()).toEqual({ naturalWidth: 1024, naturalHeight: 768, scale: 1 });

    fixture.destroy();
    expect(editor.imageViewport()).toBeNull();
  });
});
