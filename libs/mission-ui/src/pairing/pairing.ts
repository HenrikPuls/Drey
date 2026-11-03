import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';

/**
 * The pairing screen (concept §3.6): what an unpaired browser shows —
 * one input for the one-time code Drey's tickets settings displays, one
 * button. The exchange itself lives in the host's `pair` binding (the
 * state owns the token store); without a bound adapter the button stays
 * disabled — the honest placeholder, never a dead end.
 */
export type PairReply = { readonly ok: true } | { readonly ok: false; readonly error: string };

@Component({
  selector: 'mc-pairing',
  templateUrl: './pairing.html',
  styleUrl: './pairing.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Pairing {
  /** The shell's pairing phase; 'pairing' = a code is being exchanged (the
   *  shell renders this screen only while not 'ready'). */
  readonly phase = input<'needs-code' | 'pairing' | 'ready'>('needs-code');

  /** The host's pair binding; absent = the honest disabled placeholder. */
  readonly pair = input<((code: string) => Promise<PairReply>) | null | undefined>(null);

  /** The code the owner typed. */
  protected readonly code = signal('');

  /** The exchange's refusal, shown under the input. */
  protected readonly error = signal<string | null>(null);

  protected get busy(): boolean {
    return this.phase() === 'pairing';
  }

  protected get canPair(): boolean {
    const pair = this.pair();
    return pair !== null && pair !== undefined && this.code().trim() !== '' && !this.busy;
  }

  protected onCode(value: string): void {
    this.code.set(value);
    this.error.set(null);
  }

  protected async submit(): Promise<void> {
    const code = this.code().trim();
    const pair = this.pair();
    if (code === '' || pair === null || pair === undefined || this.busy) {
      return;
    }
    const reply = await pair(code);
    if (!reply.ok) {
      this.error.set(reply.error);
    }
  }
}
