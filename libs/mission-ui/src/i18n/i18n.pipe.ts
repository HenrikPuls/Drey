/**
 * `{{ 'autopilot.title' | t }}` in a Mission Control template (ADR-0091).
 * Pure: the catalog is fixed for the life of the page.
 */
import { Pipe, PipeTransform, inject } from '@angular/core';
import type { MessageParams } from '../../../../shared/i18n';
import { McI18n } from './i18n.service';

@Pipe({ name: 't', pure: true })
export class McI18nPipe implements PipeTransform {
  private readonly i18n = inject(McI18n);

  transform(key: string, params?: MessageParams): string {
    return this.i18n.lookup(key, params);
  }
}
