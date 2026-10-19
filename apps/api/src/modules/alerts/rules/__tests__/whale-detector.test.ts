import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/redis', () => ({ redis: {} }));

import {
  RollingVolumeService,
  SortedSetStore,
} from '../../../analytics/rolling-volume.service';
import { WhaleDetectorRule } from '../whale-detector';

function createInMemorySortedSetStore(): SortedSetStore & {
  dumpKey(key: string): Array<{ score: number; member: string }>;
} {
  const sets = new Map<string, Map<string, number>>();

  return {
    async zadd(key: string, score: number | string, member: string) {
      const numericScore = Number(score);
      let bucket = sets.get(key);
      if (!bucket) {
        bucket = new Map();
        sets.set(key, bucket);
      }
      const isNew = !bucket.has(member);
      bucket.set(member, numericScore);
      return isNew ? 1 : 0;
    },
    async zremrangebyscore(
      key: string,
      min: number | string,
      max: number | string
    ) {
      const bucket = sets.get(key);
      if (!bucket) return 0;
      const minVal = min === '-inf' ? -Infinity : Number(min);
      const maxVal = max === '+inf' ? Infinity : Number(max);
      let removed = 0;
      for (const [member, score] of bucket.entries()) {
        if (score >= minVal && score <= maxVal) {
          bucket.delete(member);
          removed += 1;
        }
      }
      return removed;
    },
    async zrangebyscore(
      key: string,
      min: number | string,
      max: number | string
    ) {
      const bucket = sets.get(key);
      if (!bucket) return [];
      const minVal = min === '-inf' ? -Infinity : Number(min);
      const maxVal = max === '+inf' ? Infinity : Number(max);
      return Array.from(bucket.entries())
        .filter(([, score]) => score >= minVal && score <= maxVal)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    },
    async expire() {
      return 1;
    },
    dumpKey(key: string) {
      const bucket = sets.get(key);
      if (!bucket) return [];
      return Array.from(bucket.entries()).map(([member, score]) => ({
        score,
        member,
      }));
    },
  };
}

describe('Whale Transaction Detector Rule Engine with Rolling Volumetric Baseline (#643)', () => {
  it('maintains 24-hour sliding window in Redis sorted sets and evicts expired observations', async () => {
    const store = createInMemorySortedSetStore();
    const volumeService = new RollingVolumeService(store);
    const baseTime = Date.parse('2026-10-20T12:00:00.000Z');

    // 1. Record an expired transaction (26 hours ago)
    await volumeService.recordTransaction('wallet_personal', {
      txHash: 'tx_expired_26h',
      amount: 999_999,
      asset: 'XLM',
      timestampMs: baseTime - 26 * 60 * 60 * 1000,
    });

    // 2. Record 5 transactions inside the 24h window
    const activeAmounts = [100, 120, 90, 110, 130];
    for (let i = 0; i < activeAmounts.length; i++) {
      await volumeService.recordTransaction('wallet_personal', {
        txHash: `tx_active_${i}`,
        amount: activeAmounts[i],
        asset: 'XLM',
        timestampMs: baseTime - (5 - i) * 60 * 60 * 1000,
      });
    }

    const stats = await volumeService.getBaselineStats(
      'wallet_personal',
      'XLM',
      baseTime
    );

    expect(stats.sampleCount).toBe(5);
    expect(stats.totalVolume).toBe(550);
    expect(stats.mean).toBe(110);
    expect(stats.stdDev).toBeCloseTo(14.1421356, 5);
    expect(stats.ema).toBeGreaterThan(100);
    expect(stats.ema).toBeLessThan(125);
  });

  it('triggers whale alert when a payment exceeds EMA + N * stdDev and ignores normal payments', async () => {
    const store = createInMemorySortedSetStore();
    const volumeService = new RollingVolumeService(store);
    const rule = new WhaleDetectorRule(volumeService, {
      stdDevMultiplier: 3.0,
      minSamplesForStatisticalRule: 5,
    });

    const baseTime = Date.parse('2026-10-20T12:00:00.000Z');
    const history = [100, 115, 95, 105, 110, 90, 100];

    for (let i = 0; i < history.length; i++) {
      await volumeService.recordTransaction('wallet_retail', {
        txHash: `tx_hist_${i}`,
        amount: history[i],
        asset: 'XLM',
        timestampMs: baseTime - (history.length - i) * 30 * 60 * 1000,
      });
    }

    // Normal transaction (118 XLM) is within 3 standard deviations -> does NOT trigger
    const normalEval = await rule.evaluate({
      walletId: 'wallet_retail',
      txHash: 'tx_normal_118',
      amount: 118,
      asset: 'XLM',
      timestamp: baseTime,
    });

    expect(normalEval.triggered).toBe(false);
    expect(normalEval.reason).toBe('within_normal_baseline');
    expect(normalEval.zScore).not.toBeNull();
    expect(normalEval.zScore!).toBeLessThan(3.0);

    // Whale spike (5,000 XLM on a ~100 XLM baseline wallet) -> triggers statistical_sigma_exceeded
    const whaleEval = await rule.evaluate({
      walletId: 'wallet_retail',
      txHash: 'tx_whale_5000',
      amount: 5000,
      asset: 'XLM',
      timestamp: baseTime + 1000,
    });

    expect(whaleEval.triggered).toBe(true);
    expect(whaleEval.reason).toBe('statistical_sigma_exceeded');
    expect(whaleEval.anomalyMultiplier).toBeGreaterThan(40);
    expect(whaleEval.zScore!).toBeGreaterThan(30);
  });

  it('adapts to high-volume exchange wallets without false positives for routine 5,000 XLM transfers', async () => {
    const store = createInMemorySortedSetStore();
    const volumeService = new RollingVolumeService(store);
    const rule = new WhaleDetectorRule(volumeService, {
      stdDevMultiplier: 3.0,
      minSamplesForStatisticalRule: 5,
    });

    const baseTime = Date.parse('2026-10-20T12:00:00.000Z');
    const exchangeHistory = [4800, 5200, 5100, 4900, 5300, 4700];
    for (let i = 0; i < exchangeHistory.length; i++) {
      await volumeService.recordTransaction('wallet_exchange', {
        txHash: `tx_ex_${i}`,
        amount: exchangeHistory[i],
        asset: 'XLM',
        timestampMs: baseTime - (exchangeHistory.length - i) * 60 * 1000,
      });
    }

    // 5,000 XLM is routine for this exchange wallet (anomalyMultiplier ~ 1.0)
    const routineExchangeTx = await rule.evaluate({
      walletId: 'wallet_exchange',
      txHash: 'tx_ex_routine',
      amount: 5000,
      asset: 'XLM',
      timestamp: baseTime,
    });

    expect(routineExchangeTx.triggered).toBe(false);
    expect(routineExchangeTx.reason).toBe('within_normal_baseline');
    expect(routineExchangeTx.anomalyMultiplier).toBeCloseTo(1.0, 1);
  });

  it('handles brand-new wallets with minimal history using the cold-start fallback threshold and handles zero-variance histories', async () => {
    const store = createInMemorySortedSetStore();
    const volumeService = new RollingVolumeService(store);
    const rule = new WhaleDetectorRule(volumeService, {
      stdDevMultiplier: 3.0,
      minSamplesForStatisticalRule: 5,
      fallbackMinAmount: 10_000,
      absoluteFloorAmount: 100,
    });

    const baseTime = Date.parse('2026-10-20T12:00:00.000Z');

    // Brand-new wallet with 0 prior transactions: small payment (500 XLM) does not trigger
    const firstSmall = await rule.evaluate({
      walletId: 'wallet_brand_new',
      txHash: 'tx_new_1',
      amount: 500,
      asset: 'USDC',
      timestamp: baseTime,
    });
    expect(firstSmall.triggered).toBe(false);
    expect(firstSmall.reason).toBe('below_cold_start_threshold');
    expect(firstSmall.baseline.sampleCount).toBe(0);

    // Brand-new wallet with 1 prior transaction receiving a 25,000 USDC transfer -> triggers cold-start whale alert
    const secondWhale = await rule.evaluate({
      walletId: 'wallet_brand_new',
      txHash: 'tx_new_2',
      amount: 25_000,
      asset: 'USDC',
      timestamp: baseTime + 5000,
    });
    expect(secondWhale.triggered).toBe(true);
    expect(secondWhale.reason).toBe('cold_start_fallback_exceeded');
    expect(secondWhale.baseline.sampleCount).toBe(1);

    // Zero-variance wallet (5 identical 200 XLM payments -> stdDev = 0)
    for (let i = 0; i < 5; i++) {
      await volumeService.recordTransaction('wallet_constant', {
        txHash: `tx_const_${i}`,
        amount: 200,
        asset: 'XLM',
        timestampMs: baseTime + i * 1000,
      });
    }

    const spikeOnConstant = await rule.evaluate({
      walletId: 'wallet_constant',
      txHash: 'tx_const_spike',
      amount: 800,
      asset: 'XLM',
      timestamp: baseTime + 10_000,
    });
    expect(spikeOnConstant.triggered).toBe(true);
    expect(spikeOnConstant.reason).toBe('zero_variance_multiplier_exceeded');
  });
});
