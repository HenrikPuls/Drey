import {
  ApplicationConfig,
  ErrorHandler,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  inject,
} from '@angular/core';
import { LoggingErrorHandler } from './services/log.service';
import { PluginHostService } from './plugin-host';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Mirror uncaught renderer errors into the main-process log file (ADR-0032).
    { provide: ErrorHandler, useClass: LoggingErrorHandler },
    // The plugin host gates Angular bootstrap (ADR-0044): widget,
    // settings-page and doc-kind registrations must be complete before
    // `DockService` reads the registry, the menus derive their rows, or
    // `SessionService.restore()` needs a plugin doc kind.
    provideAppInitializer(() => inject(PluginHostService).loadAll()),
  ],
};
