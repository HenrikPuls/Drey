import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { BoardSnapshot, TicketCard } from '../contracts/tickets';
import { patchTicketFile, type TransitionPatch } from '../core/ticket-files';
import { TicketStoreError, type PutOptions, type TicketDetail } from '../ports/ticket-store';
import type { WriteOutcome } from '../store/dricket-file-store';
import { DricketFileStore } from '../store/dricket-file-store';
import { FileStoreReader } from '../store/file-store-reader';
import { legacyToDricketDocument } from '../store/legacy-bridge';
import { assembleBoardFromRecords, recordToBoardFile } from '../store/store-board';
import { checkoutOf, createDricketStore, type StoreSettings } from '../store/store-settings';
import type { ChainStoreConfig } from './protocol';

/**
 * The chain orchestrator's door to a dricket store (E14-5b, ADR-0090): the board is assembled from
 * the checkout's files (the same `assembleBoardFromRecords` the engine's board uses; a ticket whose
 * lease ran out reads as unclaimed, so a dispatch IS the takeover), and the few writes the chain
 * makes itself — the ci move, the breaker's park, the manual-gate park, a Log line — are legacy-shaped
 * text patches turned back into a document by the bridge and written with `dk put` (never a file
 * write). Claims stay dk's: the chain does not stamp `claimed-by`; the run's own lease claims.
 */

/** What the chain needs of a store (a spec replaces it; production is a {@link DricketFileStore}). */
export interface ChainStoreIo {
  readAll(): Promise<readonly TicketDetail[]>;
  show(id: string): Promise<TicketDetail>;
  write(id: string, text: string, options: PutOptions): Promise<WriteOutcome>;
  comment(id: string, text: string, options: { readonly actor: string }): Promise<void>;
}

export function chainStoreSettings(config: ChainStoreConfig): StoreSettings {
  return {
    backend: 'dricket',
    shadow: false,
    dkPath: config.dkPath,
    dkStore: config.dkStore,
    dkDataDir: config.dkDataDir,
    dkCheckout: config.dkCheckout,
    dkSyncSeconds: 0,
  };
}

/** The production store of a chain config; null when there is no checkout to read the files of. */
export function chainStoreIoOf(config: ChainStoreConfig): ChainStoreIo | null {
  const settings = chainStoreSettings(config);
  const checkout = checkoutOf(settings);
  if (checkout === null) {
    return null;
  }
  return new DricketFileStore(new FileStoreReader({ root: checkout }), createDricketStore(settings), checkout);
}

export interface ChainCardPatch extends Omit<TransitionPatch, 'to' | 'from' | 'claimBy' | 'releaseClaim'> {
  /** The stage the ticket ends in; absent = where it sits. */
  readonly toStage?: string;
}

export class StoreChainBoard {
  /** The stage each ticket had when the board was last read (id -> stage), for {@link moved}. */
  private readonly stages = new Map<string, string>();

  constructor(
    private readonly io: ChainStoreIo | null,
    private readonly log: (message: string) => void,
  ) {}

  /** The board of this pass: pipeline + repos from the meta vault, tickets from the store. */
  async board(metaVaultPath: string, defaultWorker: string): Promise<BoardSnapshot> {
    const read = (rel: string): Promise<string | null> => fsp.readFile(path.join(metaVaultPath, rel), 'utf8').catch(() => null);
    const [pipelineText, reposText] = await Promise.all([read('tickets/_meta/pipeline.md'), read('tickets/_meta/repos.md')]);
    const input = { vaultId: null, vaultName: null, activeVaultName: null, isGitRepo: false, defaultWorker, pipelineText, reposText };
    if (this.io === null) {
      throw new Error('no ticket checkout configured (tickets.dk.checkout, or a local tickets.dk.store)');
    }
    const records = await this.io.readAll();
    this.stages.clear();
    for (const record of records) {
      this.stages.set(record.id, record.stage);
    }
    return assembleBoardFromRecords({ ...input, records });
  }

  /** The card's text in the legacy shape the composer and the gate read (title, `## Description`, acceptance, chapters). */
  async cardText(card: TicketCard): Promise<string | null> {
    if (this.io === null) {
      return null;
    }
    try {
      return recordToBoardFile(await this.io.show(card.id), card.phase).text;
    } catch {
      return null;
    }
  }

  /** True when the ticket is not in the stage the board was read with (moved, claimed into another stage, gone). */
  async moved(card: TicketCard): Promise<boolean> {
    if (this.io === null) {
      return true;
    }
    try {
      const was = this.stages.get(card.id);
      return was !== undefined && (await this.io.show(card.id)).stage !== was;
    } catch {
      return true;
    }
  }

  /**
   * One text patch of a free ticket written through `dk put --claim --if-version`. False (a log line)
   * when the ticket changed in the meantime (exit 12), someone holds it (exit 11) or dk refuses.
   */
  async patch(card: TicketCard, patch: ChainCardPatch, actor: string): Promise<boolean> {
    if (this.io === null) {
      return false;
    }
    try {
      const record = await this.io.show(card.id);
      if (record.rev === null) {
        throw new Error(`${card.id} has no rev: the store did not report one`);
      }
      const { toStage, ...rest } = patch;
      const legacy = patchTicketFile(recordToBoardFile(record, card.phase).text, {
        ...rest,
        to: toStage ?? card.phase,
        from: toStage === undefined ? null : card.phase,
      });
      const document = legacyToDricketDocument(record.text, legacy, { stage: toStage ?? record.stage });
      const outcome = await this.io.write(card.id, document, { expectedRev: record.rev, actor });
      if (!outcome.ok) {
        this.log(`the chain's write to ${card.id} found it changed in the meantime - nothing written`);
        return false;
      }
      if (toStage !== undefined) {
        this.stages.set(card.id, toStage);
      }
      return true;
    } catch (error) {
      const why = error instanceof TicketStoreError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
      this.log(`the chain's write to ${card.id} failed - ${why}`);
      return false;
    }
  }

  /** A comment through `dk comment` (status verbs, park notes); a failure is a log line. */
  async comment(id: string, text: string, actor: string): Promise<void> {
    if (this.io === null) {
      return;
    }
    try {
      await this.io.comment(id, text, { actor });
    } catch (error) {
      this.log(`the chain's comment on ${id} failed - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
