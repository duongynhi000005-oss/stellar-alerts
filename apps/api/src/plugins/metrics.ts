import fp from 'fastify-plugin';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { renderWebhookDispatchMetrics } from '../lib/webhook-metrics';
import {
  prometheusMetricsService,
  PrometheusMetricsService,
} from '../modules/metrics/prometheus.service';

export interface QueueMetricsSnapshot {
  queueName: string;
  waitingCount: number;
  activeCount: number;
  completedCount: number;
  failedCount: number;
  avgLatencyMs: number;
  activeWorkers: number;
  ledgerLagSeconds?: number;
}

export interface MetricsPluginOptions {
  bearerToken?: string;
  metricsService?: PrometheusMetricsService;
}

export function generatePrometheusMetrics(
  snapshot?: Partial<QueueMetricsSnapshot>,
  service: PrometheusMetricsService = prometheusMetricsService
): string {
  const qName = snapshot?.queueName || 'webhooks';
  const waiting = snapshot?.waitingCount ?? 0;
  const active = snapshot?.activeCount ?? 0;
  const completed = snapshot?.completedCount ?? 0;
  const failed = snapshot?.failedCount ?? 0;
  const latency = snapshot?.avgLatencyMs ?? 42.5;
  const workers = snapshot?.activeWorkers ?? 2;

  if (snapshot) {
    service.setQueueDepth({
      queueName: qName,
      waitingCount: waiting,
      activeCount: active,
      completedCount: completed,
      failedCount: failed,
    });
    if (snapshot.avgLatencyMs !== undefined) {
      service.observeQueueLatencyMs(snapshot.avgLatencyMs, qName);
    }
    if (snapshot.ledgerLagSeconds !== undefined) {
      service.setLedgerLagSeconds(snapshot.ledgerLagSeconds);
    }
  }

  const mem = process.memoryUsage();
  const uptime = process.uptime();

  return [
    '# HELP stellar_alerts_queue_waiting_jobs Number of waiting jobs in BullMQ queue',
    '# TYPE stellar_alerts_queue_waiting_jobs gauge',
    `stellar_alerts_queue_waiting_jobs{queue="${qName}"} ${waiting}`,
    '',
    '# HELP stellar_alerts_queue_active_jobs Number of currently processing jobs',
    '# TYPE stellar_alerts_queue_active_jobs gauge',
    `stellar_alerts_queue_active_jobs{queue="${qName}"} ${active}`,
    '',
    '# HELP stellar_alerts_queue_completed_jobs_total Total completed jobs',
    '# TYPE stellar_alerts_queue_completed_jobs_total counter',
    `stellar_alerts_queue_completed_jobs_total{queue="${qName}"} ${completed}`,
    '',
    '# HELP stellar_alerts_queue_failed_jobs_total Total failed jobs',
    '# TYPE stellar_alerts_queue_failed_jobs_total counter',
    `stellar_alerts_queue_failed_jobs_total{queue="${qName}"} ${failed}`,
    '',
    '# HELP stellar_alerts_worker_processing_latency_ms Average job processing latency in milliseconds',
    '# TYPE stellar_alerts_worker_processing_latency_ms gauge',
    `stellar_alerts_worker_processing_latency_ms{queue="${qName}"} ${latency}`,
    '',
    '# HELP stellar_alerts_active_workers_count Active worker pods/instances',
    '# TYPE stellar_alerts_active_workers_count gauge',
    `stellar_alerts_active_workers_count ${workers}`,
    '',
    '# HELP process_uptime_seconds Process uptime in seconds',
    '# TYPE process_uptime_seconds gauge',
    `process_uptime_seconds ${uptime.toFixed(1)}`,
    '',
    '# HELP nodejs_heap_used_bytes Process heap memory used in bytes',
    '# TYPE nodejs_heap_used_bytes gauge',
    `nodejs_heap_used_bytes ${mem.heapUsed}`,
    '',
    // Ingestion lag, queue latency histogram, and provider delivery SLO metrics (#646)
    service.renderMetrics(),
    '',
    // Per-phase outbound webhook dispatch histograms (DNS / TCP / TLS / TTFB /
    // response stream). Appended last so existing consumers of the queue
    // metrics keep parsing an unchanged prefix.
    renderWebhookDispatchMetrics(),
    '',
  ].join('\n');
}

const metricsPlugin: FastifyPluginAsync<MetricsPluginOptions> = async (
  fastify: FastifyInstance,
  opts: MetricsPluginOptions
) => {
  const service = opts?.metricsService ?? prometheusMetricsService;

  fastify.get('/metrics', async (request, reply) => {
    const expectedToken = opts?.bearerToken ?? process.env.METRICS_BEARER_TOKEN;
    const authHeader =
      typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined;

    if (!service.verifyBearerToken(authHeader, expectedToken)) {
      reply.code(401).header('WWW-Authenticate', 'Bearer realm="metrics"');
      return { error: 'Unauthorized: valid bearer token required for /metrics' };
    }

    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return generatePrometheusMetrics(undefined, service);
  });
};

export default fp(metricsPlugin, {
  name: 'metrics-plugin',
});
