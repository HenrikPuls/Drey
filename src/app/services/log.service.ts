import { ErrorHandler, Injectable, inject } from '@angular/core';
import type { LogEntry } from '../../../shared/ipc-api';

/**
 * Mirrors renderer errors into the main process's log file
 * (`<userData>/logs/drey.log`, ADR-0032). The packaged build runs with no
 * DevTools open, so an uncaught exception or a rejected promise would
 * otherwise vanish -- which is exactly the situation the project owner is
 * in with the intermittent app-wide input lock.
 *
 * Everything here is best-effort: a logging failure must never surface to
 * the user or break the flow that was being logged.
 */
@Injectable({ providedIn: 'root' })
export class LogService {
  private installed = false;

  /** Fire-and-forget one entry to the log file. */
  record(level: LogEntry['level'], message: string, context?: unknown): void {
    // Keep it visible in a dev console too.
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(
      `[drey] ${message}`,
      context ?? '',
    );
    try {
      void window.dreyApi?.logMessage({ level, message, context: normalizeContext(context) });
    } catch {
      // no bridge (plain `ng serve`) or the channel rejected -- nothing to do
    }
  }

  /** Attach the global `error` / `unhandledrejection` listeners once. */
  install(): void {
    if (this.installed || typeof window === 'undefined') {
      return;
    }
    this.installed = true;
    window.addEventListener('error', (event) => {
      this.record('error', `window.onerror: ${event.message}`, {
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error instanceof Error ? event.error.stack : undefined,
      });
    });
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      this.record(
        'error',
        `unhandledrejection: ${reason instanceof Error ? reason.message : String(reason)}`,
        { stack: reason instanceof Error ? reason.stack : undefined },
      );
    });
  }
}

/** Keeps the IPC payload small and always JSON-serialisable. */
function normalizeContext(context: unknown): unknown {
  if (context === undefined || context === null) {
    return undefined;
  }
  if (context instanceof Error) {
    return { name: context.name, message: context.message, stack: context.stack };
  }
  try {
    return JSON.parse(JSON.stringify(context));
  } catch {
    return String(context);
  }
}

/** Angular's global error hook -> the log file, then rethrow to the console. */
@Injectable()
export class LoggingErrorHandler implements ErrorHandler {
  private readonly log = inject(LogService);

  handleError(error: unknown): void {
    this.log.record(
      'error',
      `Angular ErrorHandler: ${error instanceof Error ? error.message : String(error)}`,
      { stack: error instanceof Error ? error.stack : undefined },
    );
    console.error(error);
  }
}
