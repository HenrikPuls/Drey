import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Startup mark (milestone 61): the moment the initial bundle finished
// parsing/evaluating — `performance.now()` is relative to navigation
// start, so this number IS the renderer's parse cost. Logged straight
// through the bridge (LogService is not injectable before bootstrap);
// `logMessage` is optional-chained so plain `ng serve` without Electron
// is unaffected.
window.dreyApi?.logMessage?.({
  level: 'info',
  message: `[startup] renderer: bundle evaluated +${Math.round(performance.now())}ms since navigation start`,
});

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
