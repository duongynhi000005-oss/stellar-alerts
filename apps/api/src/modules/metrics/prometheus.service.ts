import crypto from 'crypto';

export type DeliveryProviderType = 'webhook' | 'telegram' | 'email' | (string & {});
export type DeliveryOutcomeStatus = 'success' | 'error';

export const QUEUE_LATENCY_BUCKETS_MS = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export const HTTP_DISPATCH_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export const SUPPORTED_DELIVERY_PROVIDERS: readonly DeliveryProviderType[] = [
  'webhook',
  'telegram',
  'email',
] as const;

interface HistogramEntry {
  counts: number[];
  sum: number;
  count: number;
}

interface ProviderDeliveryStats {
  success: number;
  error: number;
}

export interface QueueDepthUpdate {
  queueName?: string;
  waitingCount: number;
  activeCount?: number;
  delayedCount?: number;
  completedCount?: number;
  failedCount?: number;
}

export class PrometheusMetricsService {
  private ledgerLagBySource = new Map<string, number>([['horizon', 0]]);
  private queueSnapshots = new Map<
    string,
    Required<Omit<QueueDepthUpdate, 'queueName'>>
  >();
  private queueLatencySeries = new Map<string, HistogramEntry>();
  private httpDispatchSeries = new Map<string, HistogramEntry>();
  private deliveryStatsByProvider = new Map<string, ProviderDeliveryStats>();

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults(): void {
    this.ledgerLagBySource.clear();
    this.ledgerLagBySource.set('horizon', 0);

    this.queueSnapshots.clear();
    this.queueSnapshots.set('webhooks', {
      waitingCount: 0,
      activeCount: 0,
      delayedCount: 0,
      completedCount: 0,
      failedCount: 0,
    });

    this.queueLatencySeries.clear();
    this.httpDispatchSeries.clear();

    this.deliveryStatsByProvider.clear();
    for (const provider of SUPPORTED_DELIVERY_PROVIDERS) {
      this.deliveryStatsByProvider.set(provider, { success: 0, error: 0 });
    }
  }

  /**
   * Resets all in-memory metric series to their initial baseline (used in unit tests).
   */
  public reset(): void {
    this.seedDefaults();
  }

  /**
   * Updates the current Stellar ledger ingestion lag in seconds (`stellar_alerts_ledger_lag_seconds`).
   */
  public setLedgerLagSeconds(lagSeconds: number, source = 'horizon'): void {
    if (!Number.isFinite(lagSeconds) || lagSeconds < 0) return;
    this.ledgerLagBySource.set(source, lagSeconds);
  }

  /**
   * Records a BullMQ job wait/processing latency observation in milliseconds
   * (`stellar_alerts_queue_latency_milliseconds`).
   */
  public observeQueueLatencyMs(latencyMs: number, queueName = 'webhooks'): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    this.observeHistogram(
      this.queueLatencySeries,
      QUEUE_LATENCY_BUCKETS_MS,
      `queue="${queueName}"`,
      latencyMs
    );
  }

  /**
   * Updates BullMQ queue depth and cumulative job counters.
   */
  public setQueueDepth(update: QueueDepthUpdate): void {
    const queueName = update.queueName || 'webhooks';
    const existing = this.queueSnapshots.get(queueName) ?? {
      waitingCount: 0,
      activeCount: 0,
      delayedCount: 0,
      completedCount: 0,
      failedCount: 0,
    };

    this.queueSnapshots.set(queueName, {
      waitingCount: update.waitingCount,
      activeCount: update.activeCount ?? existing.activeCount,
      delayedCount: update.delayedCount ?? existing.delayedCount,
      completedCount: update.completedCount ?? existing.completedCount,
      failedCount: update.failedCount ?? existing.failedCount,
    });
  }

  /**
   * Records a notification delivery outcome grouped by provider (`webhook`, `telegram`, `email`)
   * and optional HTTP/transport dispatch duration in milliseconds.
   */
  public recordDeliveryAttempt(
    provider: DeliveryProviderType,
    status: DeliveryOutcomeStatus,
    durationMs?: number
  ): void {
    const normalizedProvider = provider.trim().toLowerCase() || 'webhook';
    const current = this.deliveryStatsByProvider.get(normalizedProvider) ?? {
      success: 0,
      error: 0,
    };

    if (status === 'success') {
      current.success += 1;
    } else {
      current.error += 1;
    }
    this.deliveryStatsByProvider.set(normalizedProvider, current);

    if (durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0) {
      this.observeHistogram(
        this.httpDispatchSeries,
        HTTP_DISPATCH_BUCKETS_MS,
        `provider="${normalizedProvider}",status="${status}"`,
        durationMs
      );
    }
  }

  /**
   * Returns the current delivery success ratio `[0, 1]` for a provider (`1` when no attempts have failed).
   */
  public getProviderSuccessRatio(provider: DeliveryProviderType): number {
    const stats = this.deliveryStatsByProvider.get(provider.toLowerCase());
    if (!stats) return 1;
    const total = stats.success + stats.error;
    if (total === 0) return 1;
    return Number((stats.success / total).toFixed(6));
  }

  /**
   * Verifies an optional `Authorization: Bearer <token>` header against a configured metrics token
   * using constant-time comparison.
   */
  public verifyBearerToken(
    authorizationHeader: string | undefined,
    expectedToken: string | undefined
  ): boolean {
    if (!expectedToken || expectedToken.trim() === '') {
      return true;
    }
    if (!authorizationHeader || typeof authorizationHeader !== 'string') {
      return false;
    }

    const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return false;
    }

    const provided = Buffer.from(match[1].trim(), 'utf8');
    const expected = Buffer.from(expectedToken.trim(), 'utf8');
    if (provided.length !== expected.length) {
      return false;
    }
    return crypto.timingSafeEqual(provided, expected);
  }

  private observeHistogram(
    map: Map<string, HistogramEntry>,
    bounds: readonly number[],
    labelKey: string,
    value: number
  ): void {
    let entry = map.get(labelKey);
    if (!entry) {
      entry = {
        counts: new Array(bounds.length).fill(0),
        sum: 0,
        count: 0,
      };
      map.set(labelKey, entry);
    }

    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < bounds.length; i++) {
      if (value <= bounds[i]) {
        entry.counts[i] += 1;
      }
    }
  }

  private renderHistogramBlock(
    name: string,
    help: string,
    bounds: readonly number[],
    series: Map<string, HistogramEntry>,
    defaultLabelIfEmpty?: string
  ): string[] {
    const lines: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];

    const entries =
      series.size > 0
        ? Array.from(series.entries())
        : defaultLabelIfEmpty
          ? [
              [
                defaultLabelIfEmpty,
                {
                  counts: new Array(bounds.length).fill(0),
                  sum: 0,
                  count: 0,
                },
              ] as [string, HistogramEntry],
            ]
          : [];

    for (const [labels, entry] of entries) {
      const withBound = (bound: string) =>
        labels ? `${labels},le="${bound}"` : `le="${bound}"`;

      for (let i = 0; i < bounds.length; i++) {
        lines.push(`${name}_bucket{${withBound(String(bounds[i]))}} ${entry.counts[i]}`);
      }
      lines.push(`${name}_bucket{${withBound('+Inf')}} ${entry.count}`);

      const sumSuffix = labels ? `_sum{${labels}}` : '_sum';
      const countSuffix = labels ? `_count{${labels}}` : '_count';
      lines.push(`${name}${sumSuffix} ${Number(entry.sum.toFixed(3))}`);
      lines.push(`${name}${countSuffix} ${entry.count}`);
    }

    return lines;
  }

  /**
   * Renders all Ingestion Lag, Queue Latency, Queue Depth, and Provider Delivery SLO metrics
   * in standard Prometheus v0.0.4 text format.
   */
  public renderMetrics(): string {
    const lines: string[] = [];

    // 1. Ledger Ingestion Lag (seconds)
    lines.push(
      '# HELP stellar_alerts_ledger_lag_seconds Current Stellar ledger ingestion lag in seconds',
      '# TYPE stellar_alerts_ledger_lag_seconds gauge'
    );
    for (const [source, lag] of this.ledgerLagBySource.entries()) {
      lines.push(`stellar_alerts_ledger_lag_seconds{source="${source}"} ${lag}`);
    }
    lines.push('');

    // 2. BullMQ Queue Depth by state
    lines.push(
      '# HELP stellar_alerts_queue_depth Current BullMQ queue depth by job state',
      '# TYPE stellar_alerts_queue_depth gauge'
    );
    for (const [queue, snap] of this.queueSnapshots.entries()) {
      lines.push(`stellar_alerts_queue_depth{queue="${queue}",state="waiting"} ${snap.waitingCount}`);
      lines.push(`stellar_alerts_queue_depth{queue="${queue}",state="active"} ${snap.activeCount}`);
      lines.push(`stellar_alerts_queue_depth{queue="${queue}",state="delayed"} ${snap.delayedCount}`);
    }
    lines.push('');

    // 3. Queue Latency Histogram (milliseconds)
    lines.push(
      ...this.renderHistogramBlock(
        'stellar_alerts_queue_latency_milliseconds',
        'BullMQ alert queue wait and processing latency in milliseconds',
        QUEUE_LATENCY_BUCKETS_MS,
        this.queueLatencySeries,
        'queue="webhooks"'
      ),
      ''
    );

    // 4. Delivery Attempts, Errors, and Success Ratio by Provider (webhook, telegram, email)
    lines.push(
      '# HELP stellar_alerts_delivery_attempts_total Total alert delivery attempts by provider and status',
      '# TYPE stellar_alerts_delivery_attempts_total counter'
    );
    for (const [provider, stats] of this.deliveryStatsByProvider.entries()) {
      lines.push(
        `stellar_alerts_delivery_attempts_total{provider="${provider}",status="success"} ${stats.success}`
      );
      lines.push(
        `stellar_alerts_delivery_attempts_total{provider="${provider}",status="error"} ${stats.error}`
      );
    }
    lines.push('');

    lines.push(
      '# HELP stellar_alerts_delivery_errors_total Total failed alert deliveries by provider',
      '# TYPE stellar_alerts_delivery_errors_total counter'
    );
    for (const [provider, stats] of this.deliveryStatsByProvider.entries()) {
      lines.push(`stellar_alerts_delivery_errors_total{provider="${provider}"} ${stats.error}`);
    }
    lines.push('');

    lines.push(
      '# HELP stellar_alerts_delivery_success_ratio Delivery success ratio (0.0 to 1.0) grouped by provider',
      '# TYPE stellar_alerts_delivery_success_ratio gauge'
    );
    for (const [provider] of this.deliveryStatsByProvider.entries()) {
      const ratio = this.getProviderSuccessRatio(provider);
      lines.push(`stellar_alerts_delivery_success_ratio{provider="${provider}"} ${ratio}`);
    }
    lines.push('');

    // 5. Outbound HTTP / Provider Dispatch Duration Histogram (milliseconds)
    lines.push(
      ...this.renderHistogramBlock(
        'stellar_alerts_http_dispatch_duration_milliseconds',
        'Duration of outbound alert delivery requests in milliseconds by provider and status',
        HTTP_DISPATCH_BUCKETS_MS,
        this.httpDispatchSeries
      )
    );

    return lines.join('\n');
  }
}

export const prometheusMetricsService = new PrometheusMetricsService();
export default prometheusMetricsService;
