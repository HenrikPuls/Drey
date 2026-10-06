import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    // jsdom (the test environment) has no window.dreyApi -- same as
    // opening the page in a plain browser tab outside Electron.
    delete (window as { dreyApi?: unknown }).dreyApi;

    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('shows a warning when window.dreyApi is unavailable', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.ipc-warning')?.textContent).toContain(
      'Not running inside Electron',
    );
  });

  it('renders the titlebar and the docks that have panels', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('app-titlebar')).toBeTruthy();
    // The right dock's default resident (assistant) is a plugin widget
    // (ADR-0044) and the bottom dock has had no default resident since the
    // entry panel was removed (milestone 43); without plugins the shell
    // renders only the populated left dock.
    expect(compiled.querySelectorAll('app-dock').length).toBe(1);
    expect(compiled.querySelector('app-status-bar')).toBeTruthy();
  });
});
