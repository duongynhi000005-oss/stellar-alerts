import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'crypto';
import { env } from './config/env';
import prismaPlugin from './plugins/prisma';
import metricsPlugin from './plugins/metrics';
import { registerSSEPushPlugin } from './plugins/websocket';
import { prisma } from './lib/prisma';
import { alertQueue } from './lib/queue';
import { sorobanServer } from './lib/soroban';
import { authRoutes } from './modules/auth/auth.routes';
import { walletsRoutes } from './modules/wallets/wallets.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { webhooksRoutes } from './modules/webhooks/webhooks.routes';
import { accountRoutes } from './modules/account/account.routes';
import {
  buildStrictCorsOptions,
  registerSecurityHeaders,
} from './middleware/security.middleware';
import { registerCorrelation } from './middleware/correlation.middleware';
import { registerIdempotency } from './middleware/idempotency.middleware';
import { sorobanStateRoutes } from './modules/soroban-state/soroban-state.routes';
import { notificationsRoutes } from './modules/notifications/notifications.routes';
import { alertRulesRoutes } from './modules/alert-rules/alert-rules.routes';
import { deadLettersRoutes } from './modules/dead-letters/dead-letters.routes';
import { discordInteractionsRoutes } from './modules/discord-interactions';
import { slackRoutes } from './modules/slack/slack.routes';
import { graphqlRoutes } from './modules/graphql/graphql.routes';
import { exportsRoutes } from './modules/exports/exports.routes';
import { simulationRoutes } from './modules/simulation/simulation.routes';
import { openApiOptions } from './openapi.config';
import { loggerOptions } from './lib/logger';

import { checkRedisReadiness, getRedisStatus } from './lib/redis';
import { dbFailover } from './lib/db-failover';
import degradedModePlugin from './plugins/degraded-mode';
import { AppError } from './lib/errors';

export { openApiComponentSchemas, openApiOptions } from './openapi.config';

export const buildApp = async () => {
  // Issue #19: Correlation IDs — read x-request-id header or generate a UUID
  const app = Fastify({
    logger: loggerOptions,
    requestIdLogLabel: 'requestId',
    pluginTimeout: 30000,
    requestIdHeader: 'x-request-id',
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (incoming) {
        return Array.isArray(incoming) ? incoming[0] : incoming;
      }
      return randomUUID();
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.requestId || request.id);
  });

  // ── Security & observability hooks (registered before routes) ────────────
  await registerSecurityHeaders(app);
  await registerCorrelation(app);
  await registerIdempotency(app);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error }, error.message);
      } else {
        request.log.warn({ err: error }, error.message);
      }
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
          requestId: request.requestId || request.id,
        },
      });
    }

    if (Array.isArray((error as any).validation)) {
      request.log.warn({ err: error }, 'Request schema validation failed');
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: (error as any).validation,
          requestId: request.requestId || request.id,
        },
      });
    }

    const err = error as any;
    if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
      request.log.warn({ err: error }, 'Bad request rejected');
      return reply.status(err.statusCode).send({
        error: {
          code: 'VALIDATION_ERROR',
          message:
            err.code === 'FST_ERR_CTP_INVALID_JSON_PARSE_ERROR'
              ? 'Malformed JSON in request body'
              : 'Bad request',
          ...(Array.isArray(err.errors) ? { details: err.errors } : {}),
          requestId: request.requestId || request.id,
        },
      });
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        requestId: request.requestId || request.id,
      },
    });
  });

  // Issue #565: Strict CORS origin controls matching APP_URL / CORS_ORIGIN / CSRF_ALLOWED_ORIGINS
  const configuredOrigins = [
    process.env.APP_URL,
    process.env.CORS_ORIGIN,
    env.APP_URL,
    env.CORS_ORIGIN,
    env.CSRF_ALLOWED_ORIGINS,
  ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

  await app.register(cors, buildStrictCorsOptions(configuredOrigins));

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
  });

  await app.register(multipart, {
    limits: {
      // Per-file cap; the wasm-analyzer route additionally enforces
      // env.WASM_ANALYZER_MAX_UPLOAD_BYTES per request via request.file().
      fileSize: env.WASM_ANALYZER_MAX_UPLOAD_BYTES,
      files: 1,
    },
  });

  await app.register(swagger, openApiOptions);

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(prismaPlugin);
  await app.register(metricsPlugin);
  await app.register(degradedModePlugin);

  // Issue #64: SSE push endpoint — GET /events
  await app.register(registerSSEPushPlugin);

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  app.get('/health/ready', async (_request, reply) => {
    const redisHealth = await checkRedisReadiness();
    const database = await dbFailover.getStatus();
    const isReady = redisHealth.isReady;
    const degraded = !isReady || database.state === 'DEGRADED_READ_ONLY';
    return reply.status(isReady ? 200 : 503).send({
      status: degraded ? 'degraded' : 'ready',
      redis: redisHealth,
      database,
    });
  });

  // Issue #18: Deep Health Inspection Probe — no authentication required
  app.get('/health/deep', async (_req, reply) => {
    const checks: { postgres: 'ok' | 'error'; redis: 'ok' | 'error'; horizon: 'ok' | 'error' } = {
      postgres: 'error',
      redis: 'error',
      horizon: 'error',
    };

    // PostgreSQL ping
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch {
      // leave as 'error'
    }

    // Redis ping via BullMQ queue's underlying ioredis client
    try {
      if (alertQueue && alertQueue.client) {
        await alertQueue.client.ping();
        checks.redis = 'ok';
      }
    } catch {
      // leave as 'error'
    }

    // Horizon / Soroban RPC ping
    try {
      await sorobanServer.getLatestLedger();
      checks.horizon = 'ok';
    } catch {
      // leave as 'error'
    }

    const allOk = checks.postgres === 'ok' && checks.redis === 'ok' && checks.horizon === 'ok';
    const status = allOk ? 'ok' : 'degraded';
    const statusCode = allOk ? 200 : 503;

    return reply.code(statusCode).send({ status, checks });
  });

  app.register(authRoutes);
  app.register(walletsRoutes);
  app.register(paymentsRoutes);
  app.register(webhooksRoutes);
  app.register(accountRoutes);
  app.register(sorobanStateRoutes);
  app.register(notificationsRoutes);
  app.register(alertRulesRoutes);
  app.register(deadLettersRoutes);
  app.register(slackRoutes);
  await app.register(graphqlRoutes);
  app.register(exportsRoutes);
  app.register(simulationRoutes);
  app.register(discordInteractionsRoutes);

  return app;
};
