import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from '@angular/core';
import { LoggingErrorHandler } from './services/log.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Mirror uncaught renderer errors into the main-process log file (ADR-0032).
    { provide: ErrorHandler, useClass: LoggingErrorHandler },
  ],
};
