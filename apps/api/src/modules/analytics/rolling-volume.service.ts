import { redis as defaultRedis } from '../../lib/redis';

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_EMA_ALPHA = 0.25;
export const DEFAULT_KEY_PREFIX = 'stellar-alerts:rolling-volume';

export interface VolumeSample {
  txHash: string;
  amount: number;
  asset: string;
  timestampMs: number;
}

export interface RollingBaselineStats {
  walletId: string;
  asset: string;
  windowMs: number;
  sampleCount: number;
  totalVolume: number;
  mean: number;
  ema: number;
  stdDev: number;
  minAmount: number;
  maxAmount: number;
  oldestTimestampMs: number | null;
  newestTimestampMs: number | null;
}

/**
 * Minimal Redis Sorted-Set client contract so callers can use real `ioredis`
 * in production or an in-memory sorted set store in unit tests.
 */
export interface SortedSetStore {
  zadd(key: string, score: number | string, member: string): Promise<number | string>;
  zremrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<number>;
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    ...args: string[]
  ): Promise<string[]>;
  expire?(key: string, seconds: number): Promise<number>;
  del?(key: string): Promise<number>;
}

export class RollingVolumeService {
  constructor(
    private readonly store: SortedSetStore = defaultRedis as unknown as SortedSetStore,
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly emaAlpha: number = DEFAULT_EMA_ALPHA,
    private readonly keyPrefix: string = DEFAULT_KEY_PREFIX
  ) {
    if (emaAlpha <= 0 || emaAlpha > 1) {
      throw new Error('emaAlpha must be in (0, 1]');
    }
    if (windowMs <= 0) {
      throw new Error('windowMs must be greater than 0');
    }
  }

  /**
   * Builds the Redis sorted-set key for a `(walletId, asset)` pair.
   */
  public getSortedSetKey(walletId: string, asset = 'XLM'): string {
    const normalizedAsset = asset.trim().toUpperCase() || 'XLM';
    return `${this.keyPrefix}:${walletId}:${normalizedAsset}`;
  }

  /**
   * Encodes a payment volume sample as a deterministic sorted-set member string.
   */
  public static serializeMember(sample: VolumeSample): string {
    return JSON.stringify({
      txHash: sample.txHash,
      amount: sample.amount,
      asset: sample.asset.toUpperCase(),
      timestampMs: sample.timestampMs,
    });
  }

  /**
   * Decodes a sorted-set member string back into a `VolumeSample`.
   */
  public static deserializeMember(raw: string): VolumeSample | null {
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.txHash !== 'string' ||
        typeof parsed?.amount !== 'number' ||
        !Number.isFinite(parsed.amount) ||
        typeof parsed?.timestampMs !== 'number'
      ) {
        return null;
      }
      return {
        txHash: parsed.txHash,
        amount: parsed.amount,
        asset: typeof parsed.asset === 'string' ? parsed.asset : 'XLM',
        timestampMs: parsed.timestampMs,
      };
    } catch {
      return null;
    }
  }

  /**
   * Evicts expired observations older than `referenceTimeMs - windowMs` and records
   * a new transaction volume sample in the wallet's Redis sorted set.
   */
  public async recordTransaction(
    walletId: string,
    sample: VolumeSample
  ): Promise<void> {
    if (!walletId || typeof walletId !== 'string') {
      throw new Error('walletId is required');
    }
    if (!Number.isFinite(sample.amount) || sample.amount < 0) {
      throw new Error('Transaction amount must be a non-negative finite number');
    }

    const key = this.getSortedSetKey(walletId, sample.asset);
    const cutoffMs = sample.timestampMs - this.windowMs;

    await this.store.zremrangebyscore(key, '-inf', cutoffMs - 1);
    const member = RollingVolumeService.serializeMember(sample);
    await this.store.zadd(key, sample.timestampMs, member);

    if (typeof this.store.expire === 'function') {
      const ttlSeconds = Math.ceil(this.windowMs / 1000) + 3600;
      await this.store.expire(key, ttlSeconds);
    }
  }

  /**
   * Retrieves active volume samples within `[referenceTimeMs - windowMs, referenceTimeMs]`
   * after pruning expired entries from the sorted set.
   */
  public async getWindowSamples(
    walletId: string,
    asset = 'XLM',
    referenceTimeMs: number = Date.now()
  ): Promise<VolumeSample[]> {
    const key = this.getSortedSetKey(walletId, asset);
    const cutoffMs = referenceTimeMs - this.windowMs;

    await this.store.zremrangebyscore(key, '-inf', cutoffMs - 1);
    const rawMembers = await this.store.zrangebyscore(
      key,
      cutoffMs,
      referenceTimeMs
    );

    const samples: VolumeSample[] = [];
    for (const raw of rawMembers) {
      const decoded = RollingVolumeService.deserializeMember(raw);
      if (decoded && decoded.timestampMs >= cutoffMs && decoded.timestampMs <= referenceTimeMs) {
        samples.push(decoded);
      }
    }

    samples.sort((a, b) => a.timestampMs - b.timestampMs);
    return samples;
  }

  /**
   * Pure statistical computation of arithmetic mean, Exponential Moving Average (EMA),
   * and standard deviation over a chronological sequence of transaction amounts.
   */
  public static computeSeriesStatistics(
    samples: readonly VolumeSample[],
    emaAlpha: number = DEFAULT_EMA_ALPHA
  ): Omit<RollingBaselineStats, 'walletId' | 'asset' | 'windowMs'> {
    if (samples.length === 0) {
      return {
        sampleCount: 0,
        totalVolume: 0,
        mean: 0,
        ema: 0,
        stdDev: 0,
        minAmount: 0,
        maxAmount: 0,
        oldestTimestampMs: null,
        newestTimestampMs: null,
      };
    }

    const ordered = [...samples].sort((a, b) => a.timestampMs - b.timestampMs);
    let totalVolume = 0;
    let ema = ordered[0].amount;
    let minAmount = ordered[0].amount;
    let maxAmount = ordered[0].amount;

    for (let i = 0; i < ordered.length; i++) {
      const val = ordered[i].amount;
      totalVolume += val;
      if (i > 0) {
        ema = emaAlpha * val + (1 - emaAlpha) * ema;
      }
      if (val < minAmount) minAmount = val;
      if (val > maxAmount) maxAmount = val;
    }

    const mean = totalVolume / ordered.length;

    let sumSquaredDiffs = 0;
    for (const s of ordered) {
      const diff = s.amount - mean;
      sumSquaredDiffs += diff * diff;
    }

    const variance = sumSquaredDiffs / ordered.length;
    const stdDev = Math.sqrt(variance);

    return {
      sampleCount: ordered.length,
      totalVolume: Number(totalVolume.toFixed(7)),
      mean: Number(mean.toFixed(7)),
      ema: Number(ema.toFixed(7)),
      stdDev: Number(stdDev.toFixed(7)),
      minAmount,
      maxAmount,
      oldestTimestampMs: ordered[0].timestampMs,
      newestTimestampMs: ordered[ordered.length - 1].timestampMs,
    };
  }

  /**
   * Computes the current 24-hour rolling volumetric baseline for `(walletId, asset)`.
   */
  public async getBaselineStats(
    walletId: string,
    asset = 'XLM',
    referenceTimeMs: number = Date.now()
  ): Promise<RollingBaselineStats> {
    const normalizedAsset = asset.trim().toUpperCase() || 'XLM';
    const samples = await this.getWindowSamples(
      walletId,
      normalizedAsset,
      referenceTimeMs
    );
    const stats = RollingVolumeService.computeSeriesStatistics(
      samples,
      this.emaAlpha
    );

    return {
      walletId,
      asset: normalizedAsset,
      windowMs: this.windowMs,
      ...stats,
    };
  }
}

export const rollingVolumeService = new RollingVolumeService();
export default rollingVolumeService;
