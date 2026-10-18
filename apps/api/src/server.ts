import { env } from './config/env';
import { buildApp } from './app';
import { prisma, connectWithRetry } from './lib/prisma';
import { startTelemetry, shutdownTelemetry } from './lib/telemetry';
import { closeRedisConnections } from './lib/redis';
import { createGrpcServer } from './modules/grpc/grpc.server';
import { createLogger } from './lib/logger';

const log = createLogger({ module: 'ApiServer' });

export interface ShutdownDependencies {
  app: { close: () => Promise<unknown> };
  grpcServer?: { stop: () => void };
  prismaClient?: { $disconnect: () => Promise<unknown> };
  closeSseStreams?: () => Promise<void> | void;
  shutdownTelemetryFn?: () => Promise<unknown>;
  closeRedisFn?: () => Promise<unknown>;
  exitFn?: (code: number) => void;
  timeoutMs?: number;
}

export function createGracefulShutdownHandler(deps: ShutdownDependencies) {
  let shuttingDown = false;
  const timeoutMs = deps.timeoutMs ?? 5000;
  const exit = deps.exitFn ?? ((code: number) => process.exit(code));
  const prismaClient = deps.prismaClient ?? prisma;
  const shutdownTelemetryFn = deps.shutdownTelemetryFn ?? shutdownTelemetry;
  const closeRedisFn = deps.closeRedisFn ?? closeRedisConnections;

  return async (signal = 'SIGTERM'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal }, 'Graceful shutdown initiated');
    const forceTimer = setTimeout(() => {
      log.error('Could not close connections in time, forcefully shutting down');
      exit(1);
    }, timeoutMs);
    forceTimer.unref?.();

    try {
      deps.grpcServer?.stop();
    } catch (err) {
      console.error('Error stopping gRPC server:', err);
    }

    try {
      await deps.closeSseStreams?.();
      await deps.app.close();
      await prismaClient.$disconnect();
      await shutdownTelemetryFn();
      await closeRedisFn();
      clearTimeout(forceTimer);
      log.info('✅ Server, Watcher streams, Prisma, and Redis closed cleanly');
      exit(0);
    } catch (err) {
      clearTimeout(forceTimer);
      log.error({ err }, 'Error during graceful shutdown');
      exit(1);
    }
  };
}

const start = async () => {
  try {
    await connectWithRetry();
    await startTelemetry();
    const app = await buildApp();
    const port = parseInt(env.PORT, 10);

    await app.listen({ port, host: '0.0.0.0' });
    log.info({ port }, 'Server listening');

    const grpcServer = createGrpcServer(50051);
    grpcServer.start();

    if (process.env.START_WORKER !== 'false') {
      const { runWatcher } = await import('./workers/watcher.worker');
      runWatcher().catch((err) =>
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Watcher worker error')
      );
    }

    // Without a dedicated export worker, exports run in-process (see
    // lib/export-queue.ts), so expiry/cleanup has to run here too.
    if (env.EXPORT_WORKER_ENABLED !== 'true') {
      const { exportsService } = await import('./modules/exports/exports.service');
      const cleanupExports = () =>
        exportsService.cleanupExpiredExports().catch((err) => console.error('⚠️ Export cleanup error:', err));
      void cleanupExports();
      setInterval(cleanupExports, env.EXPORT_CLEANUP_INTERVAL_MS).unref();
    }

    const shutdown = createGracefulShutdownHandler({ app, grpcServer });

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (err) {
    log.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}
