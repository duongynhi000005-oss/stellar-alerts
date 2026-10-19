import { beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import metricsPlugin, { generatePrometheusMetrics } from '../plugins/metrics';
import {
  PrometheusMetricsService,
  prometheusMetricsService,
} from '../modules/metrics/prometheus.service';

describe('Prometheus Metrics Exporter & HPA / SLO Integration (#191 & #646)', () => {
  beforeEach(() => {
    prometheusMetricsService.reset();
    delete process.env.METRICS_BEARER_TOKEN;
  });

  it('generates standard Prometheus text format containing queue and latency metrics', () => {
    const text = generatePrometheusMetrics({
      queueName: 'webhooks',
      waitingCount: 145,
      activeCount: 12,
      completedCount: 9800,
      failedCount: 4,
      avgLatencyMs: 38.2,
      activeWorkers: 6,
    });

    expect(text).toContain('stellar_alerts_queue_waiting_jobs{queue="webhooks"} 145');
    expect(text).toContain('stellar_alerts_queue_active_jobs{queue="webhooks"} 12');
    expect(text).toContain('stellar_alerts_queue_completed_jobs_total{queue="webhooks"} 9800');
    expect(text).toContain('stellar_alerts_queue_failed_jobs_total{queue="webhooks"} 4');
    expect(text).toContain('stellar_alerts_worker_processing_latency_ms{queue="webhooks"} 38.2');
    expect(text).toContain('stellar_alerts_active_workers_count 6');
    expect(text).toContain('process_uptime_seconds');
    expect(text).toContain('nodejs_heap_used_bytes');
  });

  it('tracks stellar_alerts_ledger_lag_seconds, stellar_alerts_queue_latency_milliseconds, and provider delivery success/error ratios (#646)', () => {
    const service = new PrometheusMetricsService();

    // 1. Simulate ledger ingestion lag
    service.setLedgerLagSeconds(4.75, 'horizon');
    service.setLedgerLagSeconds(1.2, 'soroban_rpc');

    // 2. Simulate BullMQ queue depth and latency observations
    service.setQueueDepth({
      queueName: 'webhooks',
      waitingCount: 32,
      activeCount: 4,
      delayedCount: 2,
    });
    service.observeQueueLatencyMs(18, 'webhooks');
    service.observeQueueLatencyMs(120, 'webhooks');

    // 3. Simulate alert deliveries across webhook (80% success), telegram (100% success), and email (50% success)
    service.recordDeliveryAttempt('webhook', 'success', 42);
    service.recordDeliveryAttempt('webhook', 'success', 55);
    service.recordDeliveryAttempt('webhook', 'success', 68);
    service.recordDeliveryAttempt('webhook', 'success', 95);
    service.recordDeliveryAttempt('webhook', 'error', 1500);

    service.recordDeliveryAttempt('telegram', 'success', 110);
    service.recordDeliveryAttempt('telegram', 'success', 140);

    service.recordDeliveryAttempt('email', 'success', 210);
    service.recordDeliveryAttempt('email', 'error', 890);

    const output = service.renderMetrics();

    // Ledger lag assertions
    expect(output).toContain('stellar_alerts_ledger_lag_seconds{source="horizon"} 4.75');
    expect(output).toContain('stellar_alerts_ledger_lag_seconds{source="soroban_rpc"} 1.2');

    // Queue depth & latency histogram assertions
    expect(output).toContain('stellar_alerts_queue_depth{queue="webhooks",state="waiting"} 32');
    expect(output).toContain('stellar_alerts_queue_depth{queue="webhooks",state="active"} 4');
    expect(output).toContain('stellar_alerts_queue_depth{queue="webhooks",state="delayed"} 2');
    expect(output).toContain(
      'stellar_alerts_queue_latency_milliseconds_bucket{queue="webhooks",le="25"} 1'
    );
    expect(output).toContain(
      'stellar_alerts_queue_latency_milliseconds_bucket{queue="webhooks",le="250"} 2'
    );
    expect(output).toContain('stellar_alerts_queue_latency_milliseconds_count{queue="webhooks"} 2');
    expect(output).toContain('stellar_alerts_queue_latency_milliseconds_sum{queue="webhooks"} 138');

    // Provider delivery attempts, error counters, and SLO success ratios
    expect(output).toContain(
      'stellar_alerts_delivery_attempts_total{provider="webhook",status="success"} 4'
    );
    expect(output).toContain(
      'stellar_alerts_delivery_attempts_total{provider="webhook",status="error"} 1'
    );
    expect(output).toContain('stellar_alerts_delivery_errors_total{provider="webhook"} 1');
    expect(output).toContain('stellar_alerts_delivery_success_ratio{provider="webhook"} 0.8');

    expect(output).toContain(
      'stellar_alerts_delivery_attempts_total{provider="telegram",status="success"} 2'
    );
    expect(output).toContain('stellar_alerts_delivery_success_ratio{provider="telegram"} 1');

    expect(output).toContain(
      'stellar_alerts_delivery_attempts_total{provider="email",status="success"} 1'
    );
    expect(output).toContain(
      'stellar_alerts_delivery_attempts_total{provider="email",status="error"} 1'
    );
    expect(output).toContain('stellar_alerts_delivery_success_ratio{provider="email"} 0.5');

    // HTTP dispatch duration histogram
    expect(output).toContain(
      'stellar_alerts_http_dispatch_duration_milliseconds_count{provider="webhook",status="success"} 4'
    );
    expect(output).toContain(
      'stellar_alerts_http_dispatch_duration_milliseconds_count{provider="webhook",status="error"} 1'
    );
  });

  it('exposes GET /metrics endpoint returning text/plain Prometheus format when no bearer token is configured', async () => {
    const app = Fastify();
    await app.register(metricsPlugin);

    const response = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('stellar_alerts_queue_waiting_jobs');
    expect(response.body).toContain('stellar_alerts_worker_processing_latency_ms');
    expect(response.body).toContain('stellar_alerts_ledger_lag_seconds');
    expect(response.body).toContain('stellar_alerts_queue_latency_milliseconds');
    expect(response.body).toContain('stellar_alerts_delivery_success_ratio');

    await app.close();
  });

  it('protects GET /metrics with optional bearer token in production when configured (#646)', async () => {
    const app = Fastify();
    await app.register(metricsPlugin, { bearerToken: 'prod-scrape-secret-token' });

    const unauthRes = await app.inject({
      method: 'GET',
      url: '/metrics',
    });
    expect(unauthRes.statusCode).toBe(401);

    const wrongTokenRes = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: {
        authorization: 'Bearer wrong-token',
      },
    });
    expect(wrongTokenRes.statusCode).toBe(401);

    const validRes = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: {
        authorization: 'Bearer prod-scrape-secret-token',
      },
    });
    expect(validRes.statusCode).toBe(200);
    expect(validRes.body).toContain('stellar_alerts_ledger_lag_seconds');

    await app.close();
  });
});
