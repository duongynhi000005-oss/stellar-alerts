import {
  RollingVolumeService,
  rollingVolumeService as defaultRollingVolumeService,
  RollingBaselineStats,
} from '../../analytics/rolling-volume.service';

export interface WhaleDetectorConfig {
  /** Number of standard deviations above the rolling EMA required to trigger a whale alert (default: 3.0) */
  stdDevMultiplier?: number;
  /** Minimum ratio `amount / ema` required when standard deviation is zero/near-zero (default: 3.0) */
  minBaselineMultiplier?: number;
  /** Minimum historical samples in the 24h window before statistical sigma detection engages (default: 5) */
  minSamplesForStatisticalRule?: number;
  /** Absolute fallback threshold used for brand-new / cold-start wallets with fewer than `minSamplesForStatisticalRule` samples (default: 10000) */
  fallbackMinAmount?: number;
  /** Minimum absolute floor below which a transaction is never flagged as a whale regardless of variance (default: 100) */
  absoluteFloorAmount?: number;
  /** Whether to automatically append the evaluated transaction into the rolling 24h window (default: true) */
  recordSampleAfterEvaluation?: boolean;
}

export interface WhaleCandidatePayment {
  walletId: string;
  txHash: string;
  amount: number | string;
  asset?: string;
  timestamp?: Date | number | string;
}

export interface WhaleEvaluationResult {
  triggered: boolean;
  reason:
    | 'statistical_sigma_exceeded'
    | 'zero_variance_multiplier_exceeded'
    | 'cold_start_fallback_exceeded'
    | 'below_absolute_floor'
    | 'within_normal_baseline'
    | 'below_cold_start_threshold';
  walletId: string;
  txHash: string;
  asset: string;
  amount: number;
  baseline: RollingBaselineStats;
  thresholdAmount: number;
  anomalyMultiplier: number;
  zScore: number | null;
  stdDevMultiplier: number;
}

const DEFAULT_STD_DEV_MULTIPLIER = 3.0;
const DEFAULT_MIN_BASELINE_MULTIPLIER = 3.0;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_FALLBACK_MIN_AMOUNT = 10_000;
const DEFAULT_ABSOLUTE_FLOOR_AMOUNT = 100;

export class WhaleDetectorRule {
  private readonly stdDevMultiplier: number;
  private readonly minBaselineMultiplier: number;
  private readonly minSamplesForStatisticalRule: number;
  private readonly fallbackMinAmount: number;
  private readonly absoluteFloorAmount: number;
  private readonly recordSampleAfterEvaluation: boolean;

  constructor(
    private readonly volumeService: RollingVolumeService = defaultRollingVolumeService,
    config: WhaleDetectorConfig = {}
  ) {
    this.stdDevMultiplier =
      config.stdDevMultiplier ?? DEFAULT_STD_DEV_MULTIPLIER;
    this.minBaselineMultiplier =
      config.minBaselineMultiplier ?? DEFAULT_MIN_BASELINE_MULTIPLIER;
    this.minSamplesForStatisticalRule =
      config.minSamplesForStatisticalRule ?? DEFAULT_MIN_SAMPLES;
    this.fallbackMinAmount =
      config.fallbackMinAmount ?? DEFAULT_FALLBACK_MIN_AMOUNT;
    this.absoluteFloorAmount =
      config.absoluteFloorAmount ?? DEFAULT_ABSOLUTE_FLOOR_AMOUNT;
    this.recordSampleAfterEvaluation =
      config.recordSampleAfterEvaluation ?? true;

    if (this.stdDevMultiplier <= 0) {
      throw new Error('stdDevMultiplier must be greater than 0');
    }
    if (this.minSamplesForStatisticalRule < 1) {
      throw new Error('minSamplesForStatisticalRule must be at least 1');
    }
  }

  private static normalizeTimestampMs(ts?: Date | number | string): number {
    if (ts === undefined) return Date.now();
    if (typeof ts === 'number') return ts;
    if (ts instanceof Date) return ts.getTime();
    const parsed = new Date(ts).getTime();
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid payment timestamp: ${String(ts)}`);
    }
    return parsed;
  }

  /**
   * Evaluates an incoming payment against the wallet's 24-hour rolling volumetric baseline
   * (EMA and standard deviation) and optionally records the payment into the sliding window.
   */
  public async evaluate(
    payment: WhaleCandidatePayment
  ): Promise<WhaleEvaluationResult> {
    const amount =
      typeof payment.amount === 'string'
        ? Number(payment.amount)
        : payment.amount;
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('Payment amount must be a non-negative finite number');
    }

    const asset = (payment.asset || 'XLM').trim().toUpperCase();
    const timestampMs = WhaleDetectorRule.normalizeTimestampMs(
      payment.timestamp
    );

    const baseline = await this.volumeService.getBaselineStats(
      payment.walletId,
      asset,
      timestampMs
    );

    const referenceBaseline = baseline.ema > 0 ? baseline.ema : baseline.mean;
    const anomalyMultiplier =
      referenceBaseline > 0
        ? Number((amount / referenceBaseline).toFixed(4))
        : amount >= this.fallbackMinAmount
          ? Number((amount / this.fallbackMinAmount).toFixed(4))
          : 0;

    let triggered = false;
    let reason: WhaleEvaluationResult['reason'] = 'within_normal_baseline';
    let thresholdAmount = this.fallbackMinAmount;
    let zScore: number | null = null;

    if (amount < this.absoluteFloorAmount) {
      triggered = false;
      reason = 'below_absolute_floor';
      thresholdAmount = this.absoluteFloorAmount;
    } else if (baseline.sampleCount < this.minSamplesForStatisticalRule) {
      // Brand-new or sparse-history wallet: fall back to deterministic cold-start threshold
      thresholdAmount = Math.max(
        this.fallbackMinAmount,
        referenceBaseline * this.minBaselineMultiplier
      );
      if (amount >= thresholdAmount) {
        triggered = true;
        reason = 'cold_start_fallback_exceeded';
      } else {
        triggered = false;
        reason = 'below_cold_start_threshold';
      }
    } else if (baseline.stdDev > 0) {
      // Statistical rolling baseline rule: EMA + N * stdDev
      thresholdAmount = Number(
        (baseline.ema + this.stdDevMultiplier * baseline.stdDev).toFixed(7)
      );
      zScore = Number(((amount - baseline.ema) / baseline.stdDev).toFixed(4));
      if (amount > thresholdAmount) {
        triggered = true;
        reason = 'statistical_sigma_exceeded';
      } else {
        triggered = false;
        reason = 'within_normal_baseline';
      }
    } else {
      // Zero variance history (e.g. repeated identical payment amounts): require >= minBaselineMultiplier * EMA
      thresholdAmount = Number(
        (baseline.ema * this.minBaselineMultiplier).toFixed(7)
      );
      if (amount >= thresholdAmount && thresholdAmount > 0) {
        triggered = true;
        reason = 'zero_variance_multiplier_exceeded';
      } else {
        triggered = false;
        reason = 'within_normal_baseline';
      }
    }

    if (this.recordSampleAfterEvaluation) {
      await this.volumeService.recordTransaction(payment.walletId, {
        txHash: payment.txHash,
        amount,
        asset,
        timestampMs,
      });
    }

    return {
      triggered,
      reason,
      walletId: payment.walletId,
      txHash: payment.txHash,
      asset,
      amount,
      baseline,
      thresholdAmount,
      anomalyMultiplier,
      zScore,
      stdDevMultiplier: this.stdDevMultiplier,
    };
  }
}

export default WhaleDetectorRule;
