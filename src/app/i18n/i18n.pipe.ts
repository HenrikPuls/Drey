/**
 * `{{ 'autopilot.title' | t }}` and `{{ 'autopilot.resume_at' | t: { time } }}`
 * in a renderer template (ADR-0091). Pure: a key with the same params gives
 * the same text, and the catalog does not change while the app runs.
 */
import { Pipe, PipeTransform, inject } from '@angular/core';
import type { MessageParams } from '../../../shared/i18n';
import { I18nService } from './i18n.service';

@Pipe({ name: 't', pure: true })
export class I18nPipe implements PipeTransform {
  private readonly i18n = inject(I18nService);

  transform(key: string, params?: MessageParams): string {
    return this.i18n.lookup(key, params);
  }
}
