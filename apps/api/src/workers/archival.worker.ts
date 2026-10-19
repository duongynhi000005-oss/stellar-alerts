import {
  PartitionService,
  partitionService as defaultPartitionService,
  DEFAULT_HOT_RETENTION_DAYS,
  DEFAULT_ARCHIVAL_BATCH_SIZE,
  PartitionRegistrationResult,
} from '../modules/maintenance/partition.service';
import { createLogger } from '../lib/logger';

const log = createLogger({ module: 'ArchivalWorker' });

export interface ArchivalWorkerOptions {
  retentionDays?: number;
  batchSize?: number;
  maxBatchesPerCycle?: number;
  monthsAhead?: number;
  executeDdl?: boolean;
  intervalMs?: number;
  now?: () => Date;
  service?: PartitionService;
}

export interface ArchivalWorkerRunSummary {
  startedAt: Date;
  finishedAt: Date;
  retentionDays: number;
  cutoffDate: Date;
  ensuredPartitions: PartitionRegistrationResult[];
  batchesProcessed: number;
  totalScanned: number;
  totalArchived: number;
  totalDeletedFromPrimary: number;
  affectedPartitions: Record<string, number>;
}

const DEFAULT_MAX_BATCHES_PER_CYCLE = 20;
const DEFAULT_ARCHIVAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Executes a single maintenance cycle:
 * 1. Ensures monthly partitions exist for the current and upcoming months.
 * 2. Iteratively archives expired Payment records (>90 days old by default) in bounded
 *    transactional batches until no eligible records remain or `maxBatchesPerCycle` is reached.
 */
export async function runArchivalCycle(
  options: ArchivalWorkerOptions = {}
): Promise<ArchivalWorkerRunSummary> {
  const service = options.service ?? defaultPartitionService;
  const nowFn = options.now ?? (() => new Date());
  const startedAt = nowFn();
  const retentionDays = options.retentionDays ?? DEFAULT_HOT_RETENTION_DAYS;
  const batchSize = options.batchSize ?? DEFAULT_ARCHIVAL_BATCH_SIZE;
  const maxBatches = options.maxBatchesPerCycle ?? DEFAULT_MAX_BATCHES_PER_CYCLE;
  const monthsAhead = options.monthsAhead ?? 2;

  const ensuredPartitions = await service.ensureUpcomingPartitions(
    monthsAhead,
    startedAt,
    { executeDdl: options.executeDdl }
  );

  let batchesProcessed = 0;
  let totalScanned = 0;
  let totalArchived = 0;
  let totalDeletedFromPrimary = 0;
  const affectedPartitions: Record<string, number> = {};
  let cutoffDate = new Date(
    startedAt.getTime() - retentionDays * 24 * 60 * 60 * 1000
  );

  for (let i = 0; i < maxBatches; i++) {
    const batchReport = await service.archiveExpiredPayments({
      retentionDays,
      batchSize,
      now: startedAt,
    });
    cutoffDate = batchReport.cutoffDate;

    if (batchReport.scannedCount === 0) {
      break;
    }

    batchesProcessed += 1;
    totalScanned += batchReport.scannedCount;
    totalArchived += batchReport.archivedCount;
    totalDeletedFromPrimary += batchReport.deletedFromPrimaryCount;

    for (const [key, count] of Object.entries(batchReport.affectedPartitions)) {
      affectedPartitions[key] = (affectedPartitions[key] ?? 0) + count;
    }

    if (batchReport.scannedCount < batchSize) {
      break;
    }
  }

  const finishedAt = nowFn();
  const summary: ArchivalWorkerRunSummary = {
    startedAt,
    finishedAt,
    retentionDays,
    cutoffDate,
    ensuredPartitions,
    batchesProcessed,
    totalScanned,
    totalArchived,
    totalDeletedFromPrimary,
    affectedPartitions,
  };

  log.info(
    {
      retentionDays,
      batchesProcessed,
      totalArchived,
      totalDeletedFromPrimary,
      ensuredPartitionKeys: ensuredPartitions.map((p) => p.partitionKey),
    },
    'Archival & range partitioning maintenance cycle completed'
  );

  return summary;
}

let activeInterval: NodeJS.Timeout | null = null;

/**
 * Starts the periodic background archival and partition maintenance worker.
 */
export function startArchivalWorker(
  options: ArchivalWorkerOptions = {}
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? DEFAULT_ARCHIVAL_INTERVAL_MS;

  const tick = () => {
    runArchivalCycle(options).catch((error) => {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Archival worker cycle failed'
      );
    });
  };

  tick();
  activeInterval = setInterval(tick, intervalMs);
  if (typeof activeInterval.unref === 'function') {
    activeInterval.unref();
  }

  log.info({ intervalMs }, 'Automated range partitioning & archival worker started');

  return {
    stop: () => stopArchivalWorker(),
  };
}

export function stopArchivalWorker(): void {
  if (activeInterval) {
    clearInterval(activeInterval);
    activeInterval = null;
  }
}
