import { ledgerSeqFromPagingToken, BOUNDED_BACKFILL_LIMIT } from '../../lib/cursor-recovery';
import { HorizonOperationRecord, getHorizonPagingToken, getHorizonTxHash } from '../../types/horizon';

export interface GapStatus {
  hasGap: boolean;
  persistedLedger: number | null;
  networkLedger: number;
  gapSize: number;
  message?: string;
}

export interface BackfillChunkOptions {
  limit?: number;
  concurrency?: number;
}

export interface GapHealerDependencies {
  fetchLatestNetworkLedger?: () => Promise<number>;
  fetchOperationsChunk?: (
    accountOrCursor: string,
    cursor: string,
    limit: number
  ) => Promise<HorizonOperationRecord[]>;
  isTransactionAlreadyIngested?: (txHash: string) => Promise<boolean>;
  persistPayment?: (record: HorizonOperationRecord, walletId: string) => Promise<{ id: string; isNew: boolean }>;
  dispatchAlert?: (record: HorizonOperationRecord, walletId: string) => Promise<void>;
  updatePersistedCursor?: (walletId: string, cursor: string) => Promise<void>;
}

export interface HealResult {
  healed: boolean;
  gapDetected: boolean;
  fromLedger: number | null;
  toLedger: number;
  totalFetched: number;
  newlyIngested: number;
  duplicatesSkipped: number;
  alertsDispatched: number;
  finalCursor: string | null;
}

export class GapHealer {
  private chunkLimit: number;
  private concurrency: number;
  private deps: GapHealerDependencies;

  constructor(deps: GapHealerDependencies = {}, options: BackfillChunkOptions = {}) {
    this.deps = deps;
    this.chunkLimit = options.limit ?? BOUNDED_BACKFILL_LIMIT; // 200
    this.concurrency = options.concurrency ?? 5;
  }

  /**
   * Detects ledger sequence discontinuity between persisted cursor and current network height.
   */
  public detectDiscontinuity(persistedCursor: string | null | undefined, currentNetworkLedger: number): GapStatus {
    const persistedLedger = ledgerSeqFromPagingToken(persistedCursor);

    if (persistedLedger === null) {
      return {
        hasGap: false,
        persistedLedger: null,
        networkLedger: currentNetworkLedger,
        gapSize: 0,
        message: 'No previous ledger sequence found in cursor.',
      };
    }

    const gapSize = currentNetworkLedger - persistedLedger;

    if (gapSize > 1) {
      return {
        hasGap: true,
        persistedLedger,
        networkLedger: currentNetworkLedger,
        gapSize,
        message: `Ledger gap detected: persisted=${persistedLedger}, network=${currentNetworkLedger}, gap=${gapSize} ledgers.`,
      };
    }

    return {
      hasGap: false,
      persistedLedger,
      networkLedger: currentNetworkLedger,
      gapSize: Math.max(0, gapSize),
      message: 'Ledgers are continuous.',
    };
  }

  /**
   * Executes chunked parallel/sequential historical backfill for missed ledgers,
   * deduplicates transactions via database constraints, and advances cursor safely.
   */
  public async heal(
    walletId: string,
    accountPublicKey: string,
    persistedCursor: string | null | undefined,
    currentNetworkLedger?: number
  ): Promise<HealResult> {
    const networkHeight =
      currentNetworkLedger ??
      (this.deps.fetchLatestNetworkLedger ? await this.deps.fetchLatestNetworkLedger() : 0);

    const gapStatus = this.detectDiscontinuity(persistedCursor, networkHeight);

    if (!gapStatus.hasGap) {
      return {
        healed: true,
        gapDetected: false,
        fromLedger: gapStatus.persistedLedger,
        toLedger: networkHeight,
        totalFetched: 0,
        newlyIngested: 0,
        duplicatesSkipped: 0,
        alertsDispatched: 0,
        finalCursor: persistedCursor ?? null,
      };
    }

    let cursor = persistedCursor ?? '0';
    let totalFetched = 0;
    let newlyIngested = 0;
    let duplicatesSkipped = 0;
    let alertsDispatched = 0;
    let finalCursor = cursor;
    let moreRecords = true;

    // Execute chunked queries with limit 200
    while (moreRecords) {
      const records: HorizonOperationRecord[] = this.deps.fetchOperationsChunk
        ? await this.deps.fetchOperationsChunk(accountPublicKey, cursor, this.chunkLimit)
        : [];

      if (!records || records.length === 0) {
        break;
      }

      totalFetched += records.length;

      // Process and deduplicate records in chunk
      for (const record of records) {
        const txHash = getHorizonTxHash(record);
        const recordCursor = getHorizonPagingToken(record);

        if (recordCursor) {
          finalCursor = recordCursor;
          cursor = recordCursor;
        }

        // Check deduplication
        let isAlreadyIngested = false;
        if (this.deps.isTransactionAlreadyIngested) {
          isAlreadyIngested = await this.deps.isTransactionAlreadyIngested(txHash);
        }

        if (isAlreadyIngested) {
          duplicatesSkipped++;
          continue;
        }

        // Persist payment safely
        let isNew = true;
        if (this.deps.persistPayment) {
          const res = await this.deps.persistPayment(record, walletId);
          isNew = res.isNew;
        }

        if (isNew) {
          newlyIngested++;
          // Dispatch alert only for newly ingested transactions not previously seen
          if (this.deps.dispatchAlert) {
            await this.deps.dispatchAlert(record, walletId);
            alertsDispatched++;
          }
        } else {
          duplicatesSkipped++;
        }
      }

      // If fewer than limit records returned, we reached the end of the gap
      if (records.length < this.chunkLimit) {
        moreRecords = false;
      }
    }

    // Safely advance persisted cursor to the highest token
    if (finalCursor && finalCursor !== persistedCursor && this.deps.updatePersistedCursor) {
      await this.deps.updatePersistedCursor(walletId, finalCursor);
    }

    return {
      healed: true,
      gapDetected: true,
      fromLedger: gapStatus.persistedLedger,
      toLedger: networkHeight,
      totalFetched,
      newlyIngested,
      duplicatesSkipped,
      alertsDispatched,
      finalCursor,
    };
  }
}
