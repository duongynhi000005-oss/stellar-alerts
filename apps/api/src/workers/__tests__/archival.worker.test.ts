import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({ prisma: {} }));

import {
  PartitionService,
  DEFAULT_HOT_RETENTION_DAYS,
} from '../../modules/maintenance/partition.service';
import {
  runArchivalCycle,
  startArchivalWorker,
  stopArchivalWorker,
} from '../archival.worker';

interface SimPayment {
  id: string;
  walletId: string;
  txHash: string;
  fromAddress: string;
  amount: string;
  asset: string;
  assetIssuer?: string | null;
  memo?: string | null;
  receivedAt: Date;
  createdAt: Date;
}

function createInMemoryArchivalDb(options?: { failArchiveInsert?: boolean }) {
  const hotPayments = new Map<string, SimPayment>();
  const coldPayments = new Map<string, any>();
  const partitionRegistry = new Map<string, any>();
  const executedSql: string[] = [];
  let hotFindManyCount = 0;
  let coldFindManyCount = 0;

  const buildClient = (
    hotMap: Map<string, SimPayment>,
    coldMap: Map<string, any>,
    regMap: Map<string, any>
  ) => ({
    $executeRawUnsafe: async (sql: string) => {
      executedSql.push(sql);
      return 0;
    },
    payment: {
      findMany: async ({ where, orderBy, take }: any = {}) => {
        hotFindManyCount += 1;
        let rows = Array.from(hotMap.values());
        if (where?.walletId) {
          rows = rows.filter((r) => r.walletId === where.walletId);
        }
        if (where?.receivedAt?.lt) {
          rows = rows.filter(
            (r) => r.receivedAt.getTime() < where.receivedAt.lt.getTime()
          );
        }
        if (where?.receivedAt?.gte) {
          rows = rows.filter(
            (r) => r.receivedAt.getTime() >= where.receivedAt.gte.getTime()
          );
        }
        if (where?.receivedAt?.lte) {
          rows = rows.filter(
            (r) => r.receivedAt.getTime() <= where.receivedAt.lte.getTime()
          );
        }
        const dir = orderBy?.receivedAt === 'desc' ? -1 : 1;
        rows.sort(
          (a, b) => (a.receivedAt.getTime() - b.receivedAt.getTime()) * dir
        );
        if (typeof take === 'number') {
          rows = rows.slice(0, take);
        }
        return rows;
      },
      deleteMany: async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? [];
        let deleted = 0;
        for (const id of ids) {
          if (hotMap.delete(id)) {
            deleted += 1;
          }
        }
        return { count: deleted };
      },
    },
    archivedPayment: {
      createMany: async ({ data }: any) => {
        if (options?.failArchiveInsert) {
          throw new Error('Simulated cold storage write failure');
        }
        let count = 0;
        for (const row of data) {
          if (!coldMap.has(row.id)) {
            coldMap.set(row.id, row);
            count += 1;
          }
        }
        return { count };
      },
      count: async ({ where }: any) => {
        const ids: string[] = where?.id?.in ?? [];
        return ids.filter((id) => coldMap.has(id)).length;
      },
      findMany: async ({ where, orderBy, take }: any = {}) => {
        coldFindManyCount += 1;
        let rows = Array.from(coldMap.values());
        if (where?.walletId) {
          rows = rows.filter((r) => r.walletId === where.walletId);
        }
        if (where?.receivedAt?.gte) {
          rows = rows.filter(
            (r) => r.receivedAt.getTime() >= where.receivedAt.gte.getTime()
          );
        }
        if (where?.receivedAt?.lte) {
          rows = rows.filter(
            (r) => r.receivedAt.getTime() <= where.receivedAt.lte.getTime()
          );
        }
        const dir = orderBy?.receivedAt === 'desc' ? -1 : 1;
        rows.sort(
          (a, b) => (a.receivedAt.getTime() - b.receivedAt.getTime()) * dir
        );
        if (typeof take === 'number') {
          rows = rows.slice(0, take);
        }
        return rows;
      },
    },
    paymentPartitionRegistry: {
      findUnique: async ({ where }: any) =>
        regMap.get(where.partitionKey) ?? null,
      create: async ({ data }: any) => {
        const record = {
          id: `part_${regMap.size + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        regMap.set(data.partitionKey, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = regMap.get(where.partitionKey);
        const updated = { ...existing, ...data, updatedAt: new Date() };
        regMap.set(where.partitionKey, updated);
        return updated;
      },
    },
  });

  const rootClient: any = {
    ...buildClient(hotPayments, coldPayments, partitionRegistry),
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      // Snapshot maps so any thrown error rolls back atomically
      const hotSnapshot = new Map(hotPayments);
      const coldSnapshot = new Map(coldPayments);
      const regSnapshot = new Map(partitionRegistry);

      const txClient = buildClient(hotSnapshot, coldSnapshot, regSnapshot);
      const result = await fn(txClient);

      hotPayments.clear();
      for (const [k, v] of hotSnapshot) hotPayments.set(k, v);
      coldPayments.clear();
      for (const [k, v] of coldSnapshot) coldPayments.set(k, v);
      partitionRegistry.clear();
      for (const [k, v] of regSnapshot) partitionRegistry.set(k, v);

      return result;
    },
  };

  return {
    db: rootClient,
    hotPayments,
    coldPayments,
    partitionRegistry,
    executedSql,
    getQueryStats: () => ({ hotFindManyCount, coldFindManyCount }),
  };
}

describe('Automated Range Partitioning & Archival Worker (#647)', () => {
  it('computes monthly partition descriptors, DDL statements, and registers upcoming partitions', async () => {
    const { db, partitionRegistry, executedSql } = createInMemoryArchivalDb();
    const service = new PartitionService(db);

    const refDate = new Date('2026-10-15T12:00:00.000Z');
    const results = await service.ensureUpcomingPartitions(2, refDate, {
      executeDdl: true,
    });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.partitionKey)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    expect(results.map((r) => r.partitionName)).toEqual([
      'payments_y2026m10',
      'payments_y2026m11',
      'payments_y2026m12',
    ]);
    expect(partitionRegistry.size).toBe(3);
    expect(executedSql.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS "payments_y2026m10"'))).toBe(true);
    expect(executedSql.some((sql) => sql.includes('payments_y2026m10_wallet_received_idx'))).toBe(true);
  });

  it('migrates records older than 90 days to cold storage across multiple batches without data loss', async () => {
    const { db, hotPayments, coldPayments, partitionRegistry } =
      createInMemoryArchivalDb();
    const now = new Date('2026-10-20T00:00:00.000Z');

    // Seed 5 expired records (>90 days old: June and July 2026) and 3 active records (<30 days old: Oct 2026)
    const fixtures: SimPayment[] = [
      {
        id: 'pay_old_1',
        walletId: 'wallet_1',
        txHash: 'hash_old_1',
        fromAddress: 'GAAA1',
        amount: '100.00',
        asset: 'USDC',
        receivedAt: new Date('2026-06-10T10:00:00.000Z'),
        createdAt: new Date('2026-06-10T10:00:00.000Z'),
      },
      {
        id: 'pay_old_2',
        walletId: 'wallet_1',
        txHash: 'hash_old_2',
        fromAddress: 'GAAA2',
        amount: '250.50',
        asset: 'XLM',
        receivedAt: new Date('2026-06-25T14:30:00.000Z'),
        createdAt: new Date('2026-06-25T14:30:00.000Z'),
      },
      {
        id: 'pay_old_3',
        walletId: 'wallet_2',
        txHash: 'hash_old_3',
        fromAddress: 'GAAA3',
        amount: '75.00',
        asset: 'USDC',
        receivedAt: new Date('2026-07-05T08:00:00.000Z'),
        createdAt: new Date('2026-07-05T08:00:00.000Z'),
      },
      {
        id: 'pay_old_4',
        walletId: 'wallet_1',
        txHash: 'hash_old_4',
        fromAddress: 'GAAA4',
        amount: '12.25',
        asset: 'USDC',
        receivedAt: new Date('2026-07-12T09:15:00.000Z'),
        createdAt: new Date('2026-07-12T09:15:00.000Z'),
      },
      {
        id: 'pay_old_5',
        walletId: 'wallet_2',
        txHash: 'hash_old_5',
        fromAddress: 'GAAA5',
        amount: '500.00',
        asset: 'XLM',
        receivedAt: new Date('2026-07-19T23:59:00.000Z'),
        createdAt: new Date('2026-07-19T23:59:00.000Z'),
      },
      {
        id: 'pay_recent_1',
        walletId: 'wallet_1',
        txHash: 'hash_recent_1',
        fromAddress: 'GBBB1',
        amount: '40.00',
        asset: 'USDC',
        receivedAt: new Date('2026-10-01T12:00:00.000Z'),
        createdAt: new Date('2026-10-01T12:00:00.000Z'),
      },
      {
        id: 'pay_recent_2',
        walletId: 'wallet_1',
        txHash: 'hash_recent_2',
        fromAddress: 'GBBB2',
        amount: '88.00',
        asset: 'USDC',
        receivedAt: new Date('2026-10-12T12:00:00.000Z'),
        createdAt: new Date('2026-10-12T12:00:00.000Z'),
      },
      {
        id: 'pay_recent_3',
        walletId: 'wallet_2',
        txHash: 'hash_recent_3',
        fromAddress: 'GBBB3',
        amount: '19.99',
        asset: 'XLM',
        receivedAt: new Date('2026-10-19T18:00:00.000Z'),
        createdAt: new Date('2026-10-19T18:00:00.000Z'),
      },
    ];

    for (const f of fixtures) {
      hotPayments.set(f.id, f);
    }

    const service = new PartitionService(db);
    const summary = await runArchivalCycle({
      service,
      retentionDays: DEFAULT_HOT_RETENTION_DAYS,
      batchSize: 2,
      now: () => now,
    });

    expect(summary.totalScanned).toBe(5);
    expect(summary.totalArchived).toBe(5);
    expect(summary.totalDeletedFromPrimary).toBe(5);
    expect(summary.batchesProcessed).toBe(3);
    expect(summary.affectedPartitions).toEqual({
      '2026-06': 2,
      '2026-07': 3,
    });

    // Zero data loss: 3 recent remain in hot table, 5 old exist in cold storage
    expect(hotPayments.size).toBe(3);
    expect(coldPayments.size).toBe(5);
    expect(hotPayments.size + coldPayments.size).toBe(fixtures.length);
    expect(coldPayments.get('pay_old_1').partitionKey).toBe('2026-06');
    expect(coldPayments.get('pay_old_5').partitionKey).toBe('2026-07');
    expect(partitionRegistry.get('2026-06').rowCount).toBe(2);
    expect(partitionRegistry.get('2026-07').rowCount).toBe(3);
  });

  it('maintains transactional consistency and leaves primary table untouched if cold storage write fails', async () => {
    const { db, hotPayments, coldPayments } = createInMemoryArchivalDb({
      failArchiveInsert: true,
    });
    const now = new Date('2026-10-20T00:00:00.000Z');

    hotPayments.set('pay_old_atomic', {
      id: 'pay_old_atomic',
      walletId: 'wallet_1',
      txHash: 'hash_old_atomic',
      fromAddress: 'GAAA1',
      amount: '99.00',
      asset: 'USDC',
      receivedAt: new Date('2026-05-01T00:00:00.000Z'),
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
    });

    const service = new PartitionService(db);
    await expect(
      service.archiveExpiredPayments({ retentionDays: 90, now })
    ).rejects.toThrow(/Simulated cold storage write failure/);

    // Primary table still retains the row; cold table has 0 rows
    expect(hotPayments.size).toBe(1);
    expect(coldPayments.size).toBe(0);
  });

  it('routes recent queries (<30 days) exclusively to the hot table index and merges cold storage only for historical ranges', async () => {
    const { db, hotPayments, getQueryStats } = createInMemoryArchivalDb();
    const now = new Date('2026-10-20T00:00:00.000Z');

    hotPayments.set('pay_archive_june', {
      id: 'pay_archive_june',
      walletId: 'wallet_1',
      txHash: 'hash_june',
      fromAddress: 'GAAA1',
      amount: '300.00',
      asset: 'USDC',
      receivedAt: new Date('2026-06-15T00:00:00.000Z'),
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
    });
    hotPayments.set('pay_hot_oct', {
      id: 'pay_hot_oct',
      walletId: 'wallet_1',
      txHash: 'hash_oct',
      fromAddress: 'GBBB1',
      amount: '50.00',
      asset: 'USDC',
      receivedAt: new Date('2026-10-10T00:00:00.000Z'),
      createdAt: new Date('2026-10-10T00:00:00.000Z'),
    });

    const service = new PartitionService(db);
    await service.archiveExpiredPayments({ retentionDays: 90, now });

    // 1. Recent (<30 days) query hits ONLY hot table (coldFindManyCount remains 0)
    const recentResult = await service.queryPaymentsWithHotColdRouting({
      walletId: 'wallet_1',
      fromDate: new Date('2026-09-25T00:00:00.000Z'),
      toDate: now,
      now,
    });

    expect(recentResult.executionPath).toBe('hot_only');
    expect(recentResult.records).toHaveLength(1);
    expect((recentResult.records[0] as any).id).toBe('pay_hot_oct');
    expect(getQueryStats().coldFindManyCount).toBe(0);

    // 2. Historical query spanning back to June transparently unions hot + cold partitions
    const historicalResult = await service.queryPaymentsWithHotColdRouting({
      walletId: 'wallet_1',
      fromDate: new Date('2026-06-01T00:00:00.000Z'),
      toDate: now,
      now,
    });

    expect(historicalResult.executionPath).toBe('hot_and_cold');
    expect(historicalResult.records).toHaveLength(2);
    expect(historicalResult.hotCount).toBe(1);
    expect(historicalResult.coldCount).toBe(1);
    expect(getQueryStats().coldFindManyCount).toBe(1);

    // Verify worker start/stop lifecycle
    const handle = startArchivalWorker({
      service,
      intervalMs: 60_000,
      now: () => now,
    });
    handle.stop();
    stopArchivalWorker();
  });
});
