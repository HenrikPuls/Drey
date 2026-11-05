import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { trackVisualViewport } from './app/viewport';

trackVisualViewport(window);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
