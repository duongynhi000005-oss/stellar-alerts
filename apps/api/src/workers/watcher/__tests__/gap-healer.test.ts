import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GapHealer, GapHealerDependencies } from '../gap-healer';
import { HorizonOperationRecord } from '../../../types/horizon';

describe('GapHealer (#740)', () => {
  let mockDeps: GapHealerDependencies;
  let gapHealer: GapHealer;

  beforeEach(() => {
    mockDeps = {
      fetchLatestNetworkLedger: vi.fn().mockResolvedValue(100),
      fetchOperationsChunk: vi.fn().mockResolvedValue([]),
      isTransactionAlreadyIngested: vi.fn().mockResolvedValue(false),
      persistPayment: vi.fn().mockResolvedValue({ id: 'pay_1', isNew: true }),
      dispatchAlert: vi.fn().mockResolvedValue(undefined),
      updatePersistedCursor: vi.fn().mockResolvedValue(undefined),
    };
    gapHealer = new GapHealer(mockDeps, { limit: 200 });
  });

  describe('detectDiscontinuity', () => {
    it('detects ledger sequence discontinuity between persisted cursor and current network height', () => {
      // Paging token with ledger 90: (90n << 32n).toString()
      const cursorAtLedger90 = (90n << 32n).toString();
      const currentNetworkLedger = 100; // 10 ledgers ahead

      const status = gapHealer.detectDiscontinuity(cursorAtLedger90, currentNetworkLedger);

      expect(status.hasGap).toBe(true);
      expect(status.persistedLedger).toBe(90);
      expect(status.networkLedger).toBe(100);
      expect(status.gapSize).toBe(10);
      expect(status.message).toContain('10 ledgers');
    });

    it('returns hasGap: false when ledgers are continuous', () => {
      const cursorAtLedger99 = (99n << 32n).toString();
      const currentNetworkLedger = 100;

      const status = gapHealer.detectDiscontinuity(cursorAtLedger99, currentNetworkLedger);

      expect(status.hasGap).toBe(false);
      expect(status.gapSize).toBe(1);
    });

    it('handles missing or unparseable cursor gracefully without crashing', () => {
      const statusNull = gapHealer.detectDiscontinuity(null, 100);
      expect(statusNull.hasGap).toBe(false);
      expect(statusNull.persistedLedger).toBeNull();

      const statusZero = gapHealer.detectDiscontinuity('0', 100);
      expect(statusZero.hasGap).toBe(false);
    });
  });

  describe('heal (10-ledger gap recovery & deduplication)', () => {
    it('simulates 10-ledger gap and verifies complete recovery of all missing transactions', () => {
      const walletId = 'wallet-123';
      const publicKey = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
      const cursorAtLedger90 = (90n << 32n).toString();
      const networkHeight = 100;

      // 10 transactions across the missing 10 ledgers
      const mockRecords: HorizonOperationRecord[] = Array.from({ length: 10 }, (_, i) => {
        const ledger = 91 + i;
        const pagingToken = ((BigInt(ledger) << 32n) | BigInt(i + 1)).toString();
        return {
          id: `op_${ledger}`,
          paging_token: pagingToken,
          transaction_hash: `tx_hash_${ledger}`,
          type: 'payment',
          created_at: new Date(1700000000000 + i * 5000).toISOString(),
          amount: '50.00',
          asset_type: 'native',
          from: 'G_SENDER',
          to: publicKey,
        } as unknown as HorizonOperationRecord;
      });

      mockDeps.fetchOperationsChunk = vi.fn().mockResolvedValue(mockRecords);

      return gapHealer.heal(walletId, publicKey, cursorAtLedger90, networkHeight).then((result) => {
        expect(result.healed).toBe(true);
        expect(result.gapDetected).toBe(true);
        expect(result.fromLedger).toBe(90);
        expect(result.toLedger).toBe(100);
        expect(result.totalFetched).toBe(10);
        expect(result.newlyIngested).toBe(10);
        expect(result.duplicatesSkipped).toBe(0);
        expect(result.alertsDispatched).toBe(10);

        // Dispatched alerts for all 10 recovered transactions
        expect(mockDeps.dispatchAlert).toHaveBeenCalledTimes(10);

        // Safe cursor advancement to the latest recovered record's paging token
        const expectedFinalCursor = mockRecords[9].paging_token;
        expect(result.finalCursor).toBe(expectedFinalCursor);
        expect(mockDeps.updatePersistedCursor).toHaveBeenCalledWith(walletId, expectedFinalCursor);
      });
    });

    it('verifies NO duplicate alert dispatches for transactions already ingested prior to gap', async () => {
      const walletId = 'wallet-456';
      const publicKey = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
      const cursorAtLedger90 = (90n << 32n).toString();
      const networkHeight = 100;

      const mockRecords: HorizonOperationRecord[] = [
        {
          id: 'op_91',
          paging_token: ((91n << 32n) | 1n).toString(),
          transaction_hash: 'tx_already_ingested_1',
          type: 'payment',
          created_at: new Date().toISOString(),
          amount: '10.0',
          asset_type: 'native',
          from: 'G_FROM',
          to: publicKey,
        } as unknown as HorizonOperationRecord,
        {
          id: 'op_92',
          paging_token: ((92n << 32n) | 1n).toString(),
          transaction_hash: 'tx_already_ingested_2',
          type: 'payment',
          created_at: new Date().toISOString(),
          amount: '20.0',
          asset_type: 'native',
          from: 'G_FROM',
          to: publicKey,
        } as unknown as HorizonOperationRecord,
        {
          id: 'op_93',
          paging_token: ((93n << 32n) | 1n).toString(),
          transaction_hash: 'tx_new_missed_3',
          type: 'payment',
          created_at: new Date().toISOString(),
          amount: '30.0',
          asset_type: 'native',
          from: 'G_FROM',
          to: publicKey,
        } as unknown as HorizonOperationRecord,
      ];

      mockDeps.fetchOperationsChunk = vi.fn().mockResolvedValue(mockRecords);

      // First two transactions already exist in database
      mockDeps.isTransactionAlreadyIngested = vi.fn().mockImplementation(async (txHash: string) => {
        return txHash.startsWith('tx_already_ingested');
      });

      const result = await gapHealer.heal(walletId, publicKey, cursorAtLedger90, networkHeight);

      expect(result.totalFetched).toBe(3);
      expect(result.duplicatesSkipped).toBe(2);
      expect(result.newlyIngested).toBe(1);
      expect(result.alertsDispatched).toBe(1);

      // Only ONE alert dispatched for tx_new_missed_3
      expect(mockDeps.dispatchAlert).toHaveBeenCalledTimes(1);
      expect(mockDeps.dispatchAlert).toHaveBeenCalledWith(mockRecords[2], walletId);
    });

    it('returns immediately without queries when no gap is detected', async () => {
      const walletId = 'wallet-continuous';
      const publicKey = 'G_PUBLIC';
      const cursorAtLedger100 = (100n << 32n).toString();
      const networkHeight = 100;

      const result = await gapHealer.heal(walletId, publicKey, cursorAtLedger100, networkHeight);

      expect(result.gapDetected).toBe(false);
      expect(result.totalFetched).toBe(0);
      expect(mockDeps.fetchOperationsChunk).not.toHaveBeenCalled();
      expect(mockDeps.dispatchAlert).not.toHaveBeenCalled();
    });
  });
});
