import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { installScrollDebug } from './app/scroll-debug';
import { lockPageScroll } from './app/scroll-lock';
import { trackVisualViewport } from './app/viewport';

lockPageScroll(window);
if (new URLSearchParams(window.location.search).get('debug') === 'scroll') {
  installScrollDebug(window);
}
trackVisualViewport(window);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
