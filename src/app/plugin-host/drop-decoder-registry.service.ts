import { Injectable, inject } from '@angular/core';
import type { DropDecoderContrib, Unsubscribe } from '../../../shared/plugin-api/renderer';
import { LogService } from '../services/log.service';

/**
 * The drop-decoder seam (ADR-0044 stage 2): a plugin can claim a MIME
 * family dropped onto an editor surface (`.ics`/`.msg` meetings, template
 * drags) before the base file/image cascade runs. First `match()` wins;
 * a decoder that throws surfaces its rejection to the drop handler, which
 * shows the user-facing message.
 */
@Injectable({ providedIn: 'root' })
export class DropDecoderRegistry {
  private readonly log = inject(LogService);
  private readonly decoders: DropDecoderContrib[] = [];

  register(decoder: DropDecoderContrib): Unsubscribe {
    this.decoders.push(decoder);
    return () => {
      const index = this.decoders.indexOf(decoder);
      if (index !== -1) {
        this.decoders.splice(index, 1);
      }
    };
  }

  /**
   * SYNCHRONOUS claim check for the drop handler: does any registered
   * decoder want this drop? A `match()` that throws is logged and treated
   * as "not claimed".
   */
  claims(data: DataTransfer): boolean {
    return this.decoders.some((d) => {
      try {
        return d.match(data);
      } catch (error) {
        this.log.record('error', `plugin drop-decoder match failed: ${String(error)}`);
        return false;
      }
    });
  }

  /**
   * Runs the first claiming decoder. Resolves `null` when none claims the
   * drop (the base cascade proceeds); rejects with the decoder's error when
   * a claimed decode fails.
   */
  async decode(data: DataTransfer): Promise<string | null> {
    const decoder = this.decoders.find((d) => {
      try {
        return d.match(data);
      } catch (error) {
        this.log.record('error', `plugin drop-decoder match failed: ${String(error)}`);
        return false;
      }
    });
    if (decoder === undefined) {
      return null;
    }
    return await decoder.decode(data);
  }
}
