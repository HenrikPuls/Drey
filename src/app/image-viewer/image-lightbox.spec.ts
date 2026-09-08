import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ImageLightbox } from './image-lightbox';
import { ImageLightboxService } from './image-lightbox.service';

describe('ImageLightboxService', () => {
  it('toggles src and replaces an already-open image', () => {
    const svc = new ImageLightboxService();
    expect(svc.src()).toBeNull();
    svc.open('drey-asset://asset/a.png');
    expect(svc.src()).toBe('drey-asset://asset/a.png');
    svc.open('drey-asset://asset/b.png');
    expect(svc.src()).toBe('drey-asset://asset/b.png');
    svc.close();
    expect(svc.src()).toBeNull();
  });
});

describe('ImageLightbox', () => {
  let fixture: ComponentFixture<ImageLightbox>;
  let svc: ImageLightboxService;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ImageLightbox] }).compileComponents();
    svc = TestBed.inject(ImageLightboxService);
    fixture = TestBed.createComponent(ImageLightbox);
    fixture.detectChanges();
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => svc.close());

  it('renders nothing while closed', () => {
    expect(el.querySelector('.backdrop')).toBeNull();
  });

  it('renders the backdrop + viewer once opened', async () => {
    svc.open('data:image/png;base64,iVBORw0KGgo=');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(el.querySelector('.backdrop')).not.toBeNull();
    const img = el.querySelector('app-image-viewer img') as HTMLImageElement | null;
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(document.activeElement).toBe(el.querySelector('.close'));
  });

  it('closes on Escape', () => {
    svc.open('data:image/png;base64,iVBORw0KGgo=');
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(svc.src()).toBeNull();
  });

  it('closes on a backdrop click but not on a click inside the frame', () => {
    svc.open('data:image/png;base64,iVBORw0KGgo=');
    fixture.detectChanges();

    (el.querySelector('.frame') as HTMLElement).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    expect(svc.src()).not.toBeNull();

    (el.querySelector('.backdrop') as HTMLElement).dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    fixture.detectChanges();
    expect(svc.src()).toBeNull();
  });

  it('restores focus to the opener on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    svc.open('data:image/png;base64,iVBORw0KGgo=');
    fixture.detectChanges();
    await fixture.whenStable();

    svc.close();
    fixture.detectChanges();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
