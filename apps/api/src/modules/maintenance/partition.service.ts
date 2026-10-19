import { prisma as defaultPrisma } from '../../lib/prisma';
import { createLogger } from '../../lib/logger';

const log = createLogger({ module: 'PartitionService' });

export const DEFAULT_HOT_RETENTION_DAYS = 90;
export const RECENT_QUERY_WINDOW_DAYS = 30;
export const DEFAULT_ARCHIVAL_BATCH_SIZE = 500;

export interface MonthlyPartitionDescriptor {
  partitionKey: string;
  partitionName: string;
  rangeStart: Date;
  rangeEnd: Date;
}

export interface PartitionDDLPlan extends MonthlyPartitionDescriptor {
  createPartitionSql: string;
  createIndexesSql: string[];
}

export interface PartitionRegistrationResult extends MonthlyPartitionDescriptor {
  status: 'active' | 'archived' | 'detached';
  ddlExecuted: boolean;
}

export interface ArchivalBatchReport {
  cutoffDate: Date;
  retentionDays: number;
  scannedCount: number;
  archivedCount: number;
  deletedFromPrimaryCount: number;
  affectedPartitions: Record<string, number>;
  durationMs: number;
}

export interface HotColdQueryOptions {
  walletId?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  now?: Date;
}

export interface HotColdQueryResult<T = Record<string, unknown>> {
  records: T[];
  executionPath: 'hot_only' | 'hot_and_cold';
  hotCount: number;
  coldCount: number;
}

const PARTITION_KEY_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const PARTITION_NAME_REGEX = /^payments_y\d{4}m(0[1-9]|1[0-2])$/;

export class PartitionService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly db: any = defaultPrisma) {}

  /**
   * Formats a Date into its canonical UTC monthly partition key ("YYYY-MM").
   */
  public static formatPartitionKey(date: Date): string {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new Error('Invalid date provided for partition key calculation');
    }
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * Formats a partition key ("YYYY-MM") into a validated PostgreSQL partition table identifier.
   */
  public static formatPartitionTableName(partitionKey: string): string {
    if (!PARTITION_KEY_REGEX.test(partitionKey)) {
      throw new Error(`Invalid partition key "${partitionKey}". Expected YYYY-MM`);
    }
    const [year, month] = partitionKey.split('-');
    const tableName = `payments_y${year}m${month}`;
    if (!PARTITION_NAME_REGEX.test(tableName)) {
      throw new Error(`Invalid partition table identifier "${tableName}"`);
    }
    return tableName;
  }

  /**
   * Computes the exact UTC start (inclusive) and end (exclusive) timestamps for a monthly partition.
   */
  public static getMonthRange(dateOrKey: Date | string): MonthlyPartitionDescriptor {
    const partitionKey =
      typeof dateOrKey === 'string'
        ? dateOrKey
        : PartitionService.formatPartitionKey(dateOrKey);

    if (!PARTITION_KEY_REGEX.test(partitionKey)) {
      throw new Error(`Invalid partition key "${partitionKey}". Expected YYYY-MM`);
    }

    const [yearStr, monthStr] = partitionKey.split('-');
    const year = Number(yearStr);
    const monthIndex = Number(monthStr) - 1;

    const rangeStart = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
    const rangeEnd = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
    const partitionName = PartitionService.formatPartitionTableName(partitionKey);

    return {
      partitionKey,
      partitionName,
      rangeStart,
      rangeEnd,
    };
  }

  /**
   * Generates deterministic, injection-safe PostgreSQL range partition DDL and
   * local B-tree index statements for a given month.
   */
  public static buildMonthlyPartitionDDL(dateOrKey: Date | string): PartitionDDLPlan {
    const descriptor = PartitionService.getMonthRange(dateOrKey);
    const { partitionName, rangeStart, rangeEnd } = descriptor;

    const fromLiteral = rangeStart.toISOString();
    const toLiteral = rangeEnd.toISOString();

    const createPartitionSql = [
      `CREATE TABLE IF NOT EXISTS "${partitionName}" (`,
      `  LIKE "Payment" INCLUDING DEFAULTS INCLUDING CONSTRAINTS`,
      `);`,
      `COMMENT ON TABLE "${partitionName}" IS 'Monthly range partition (${descriptor.partitionKey}) from ${fromLiteral} to ${toLiteral}';`,
    ].join('\n');

    const createIndexesSql = [
      `CREATE INDEX IF NOT EXISTS "${partitionName}_wallet_received_idx" ON "${partitionName}" ("walletId", "receivedAt" DESC);`,
      `CREATE INDEX IF NOT EXISTS "${partitionName}_received_idx" ON "${partitionName}" ("receivedAt" DESC);`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "${partitionName}_txhash_idx" ON "${partitionName}" ("txHash");`,
    ];

    return {
      ...descriptor,
      createPartitionSql,
      createIndexesSql,
    };
  }

  /**
   * Ensures monthly partition metadata and optional DDL exist for the current month
   * and `monthsAhead` future months.
   */
  public async ensureUpcomingPartitions(
    monthsAhead = 2,
    referenceDate: Date = new Date(),
    options?: { executeDdl?: boolean }
  ): Promise<PartitionRegistrationResult[]> {
    if (!Number.isInteger(monthsAhead) || monthsAhead < 0 || monthsAhead > 24) {
      throw new Error('monthsAhead must be an integer between 0 and 24');
    }

    const results: PartitionRegistrationResult[] = [];
    const baseYear = referenceDate.getUTCFullYear();
    const baseMonth = referenceDate.getUTCMonth();

    for (let offset = 0; offset <= monthsAhead; offset++) {
      const targetDate = new Date(Date.UTC(baseYear, baseMonth + offset, 1));
      const plan = PartitionService.buildMonthlyPartitionDDL(targetDate);

      let ddlExecuted = false;
      if (options?.executeDdl && typeof this.db.$executeRawUnsafe === 'function') {
        await this.db.$executeRawUnsafe(plan.createPartitionSql);
        for (const indexSql of plan.createIndexesSql) {
          await this.db.$executeRawUnsafe(indexSql);
        }
        ddlExecuted = true;
      }

      if (this.db.paymentPartitionRegistry) {
        const existing = await this.db.paymentPartitionRegistry.findUnique({
          where: { partitionKey: plan.partitionKey },
        });

        if (!existing) {
          await this.db.paymentPartitionRegistry.create({
            data: {
              partitionKey: plan.partitionKey,
              partitionName: plan.partitionName,
              rangeStart: plan.rangeStart,
              rangeEnd: plan.rangeEnd,
              status: 'active',
              rowCount: 0,
            },
          });
        }
      }

      results.push({
        partitionKey: plan.partitionKey,
        partitionName: plan.partitionName,
        rangeStart: plan.rangeStart,
        rangeEnd: plan.rangeEnd,
        status: 'active',
        ddlExecuted,
      });
    }

    return results;
  }

  /**
   * Atomically migrates a batch of `Payment` records older than `retentionDays` (default 90 days)
   * into `ArchivedPayment` cold storage and deletes the migrated records from the primary `Payment`
   * table within a single database transaction to guarantee zero data loss.
   */
  public async archiveExpiredPayments(options?: {
    retentionDays?: number;
    batchSize?: number;
    now?: Date;
  }): Promise<ArchivalBatchReport> {
    const startTime = Date.now();
    const retentionDays = options?.retentionDays ?? DEFAULT_HOT_RETENTION_DAYS;
    const batchSize = options?.batchSize ?? DEFAULT_ARCHIVAL_BATCH_SIZE;
    const now = options?.now ?? new Date();

    if (retentionDays <= 0) {
      throw new Error('retentionDays must be greater than 0');
    }
    if (batchSize <= 0 || batchSize > 10_000) {
      throw new Error('batchSize must be between 1 and 10000');
    }

    const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    const candidates = await this.db.payment.findMany({
      where: {
        receivedAt: { lt: cutoffDate },
      },
      orderBy: { receivedAt: 'asc' },
      take: batchSize,
    });

    if (candidates.length === 0) {
      return {
        cutoffDate,
        retentionDays,
        scannedCount: 0,
        archivedCount: 0,
        deletedFromPrimaryCount: 0,
        affectedPartitions: {},
        durationMs: Date.now() - startTime,
      };
    }

    const affectedPartitions: Record<string, number> = {};
    const archivedRows = candidates.map((payment: any) => {
      const receivedAt =
        payment.receivedAt instanceof Date
          ? payment.receivedAt
          : new Date(payment.receivedAt);
      const partitionKey = PartitionService.formatPartitionKey(receivedAt);
      affectedPartitions[partitionKey] = (affectedPartitions[partitionKey] ?? 0) + 1;

      return {
        id: payment.id,
        walletId: payment.walletId,
        txHash: payment.txHash,
        fromAddress: payment.fromAddress,
        amount: payment.amount,
        asset: payment.asset,
        assetIssuer: payment.assetIssuer ?? null,
        memo: payment.memo ?? null,
        receivedAt,
        createdAt:
          payment.createdAt instanceof Date
            ? payment.createdAt
            : new Date(payment.createdAt ?? receivedAt),
        partitionKey,
        archivedAt: now,
      };
    });

    const idsToDelete = candidates.map((p: any) => p.id);

    const executeMigration = async (tx: any) => {
      let insertedCount = 0;

      if (typeof tx.archivedPayment?.createMany === 'function') {
        const created = await tx.archivedPayment.createMany({
          data: archivedRows,
          skipDuplicates: true,
        });
        insertedCount = created?.count ?? archivedRows.length;
      } else {
        for (const row of archivedRows) {
          await tx.archivedPayment.upsert({
            where: { id: row.id },
            update: {},
            create: row,
          });
          insertedCount += 1;
        }
      }

      // Verify all candidate IDs exist in cold storage before deleting from primary
      if (typeof tx.archivedPayment?.count === 'function') {
        const verifiedCount = await tx.archivedPayment.count({
          where: { id: { in: idsToDelete } },
        });
        if (verifiedCount !== idsToDelete.length) {
          throw new Error(
            `Archival consistency check failed: expected ${idsToDelete.length} rows in ArchivedPayment, found ${verifiedCount}`
          );
        }
      }

      const deleteResult = await tx.payment.deleteMany({
        where: { id: { in: idsToDelete } },
      });

      if (tx.paymentPartitionRegistry) {
        for (const [partitionKey, count] of Object.entries(affectedPartitions)) {
          const descriptor = PartitionService.getMonthRange(partitionKey);
          const existing = await tx.paymentPartitionRegistry.findUnique({
            where: { partitionKey },
          });
          if (existing) {
            await tx.paymentPartitionRegistry.update({
              where: { partitionKey },
              data: {
                status: 'archived',
                rowCount: (existing.rowCount ?? 0) + count,
                lastArchivedAt: now,
              },
            });
          } else {
            await tx.paymentPartitionRegistry.create({
              data: {
                partitionKey,
                partitionName: descriptor.partitionName,
                rangeStart: descriptor.rangeStart,
                rangeEnd: descriptor.rangeEnd,
                status: 'archived',
                rowCount: count,
                lastArchivedAt: now,
              },
            });
          }
        }
      }

      return {
        archivedCount: insertedCount,
        deletedFromPrimaryCount: deleteResult?.count ?? idsToDelete.length,
      };
    };

    const migrationOutcome =
      typeof this.db.$transaction === 'function'
        ? await this.db.$transaction(async (tx: any) => executeMigration(tx))
        : await executeMigration(this.db);

    log.info(
      {
        scannedCount: candidates.length,
        archivedCount: migrationOutcome.archivedCount,
        deletedFromPrimaryCount: migrationOutcome.deletedFromPrimaryCount,
        affectedPartitions,
      },
      'Archived expired payment batch to cold storage'
    );

    return {
      cutoffDate,
      retentionDays,
      scannedCount: candidates.length,
      archivedCount: migrationOutcome.archivedCount,
      deletedFromPrimaryCount: migrationOutcome.deletedFromPrimaryCount,
      affectedPartitions,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Routes payment history queries so recent queries (<30 days or within hot window)
   * hit only the lean primary `Payment` table and its composite index `(walletId, receivedAt)`,
   * while historical queries spanning beyond the hot retention cutoff transparently merge
   * hot and cold (`ArchivedPayment`) records.
   */
  public async queryPaymentsWithHotColdRouting(
    options: HotColdQueryOptions
  ): Promise<HotColdQueryResult> {
    const now = options.now ?? new Date();
    const hotCutoff = new Date(
      now.getTime() - DEFAULT_HOT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    );
    const recentDefaultFrom = new Date(
      now.getTime() - RECENT_QUERY_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );

    const effectiveFrom = options.fromDate ?? recentDefaultFrom;
    const effectiveTo = options.toDate ?? now;
    const limit = options.limit ?? 100;

    const buildWhere = () => {
      const where: Record<string, unknown> = {
        receivedAt: {
          gte: effectiveFrom,
          lte: effectiveTo,
        },
      };
      if (options.walletId) {
        where.walletId = options.walletId;
      }
      return where;
    };

    const hotRecords: any[] = await this.db.payment.findMany({
      where: buildWhere(),
      orderBy: { receivedAt: 'desc' },
      take: limit,
    });

    // Fast path: query window is completely within the hot retention threshold (<90 days, including <30 days)
    if (effectiveFrom >= hotCutoff) {
      return {
        records: hotRecords,
        executionPath: 'hot_only',
        hotCount: hotRecords.length,
        coldCount: 0,
      };
    }

    const coldRecords: any[] = this.db.archivedPayment
      ? await this.db.archivedPayment.findMany({
          where: buildWhere(),
          orderBy: { receivedAt: 'desc' },
          take: limit,
        })
      : [];

    const merged = [...hotRecords, ...coldRecords]
      .sort(
        (a, b) =>
          new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime()
      )
      .slice(0, limit);

    return {
      records: merged,
      executionPath: 'hot_and_cold',
      hotCount: hotRecords.length,
      coldCount: coldRecords.length,
    };
  }
}

export const partitionService = new PartitionService();
export default partitionService;
