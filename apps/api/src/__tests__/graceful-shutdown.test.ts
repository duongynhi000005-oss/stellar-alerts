import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../app', () => ({
  buildApp: vi.fn(),
}));

vi.mock('../modules/grpc/grpc.server', () => ({
  createGrpcServer: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
  connectWithRetry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/telemetry', () => ({
  startTelemetry: vi.fn().mockResolvedValue(undefined),
  shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/redis', () => ({
  closeRedisConnections: vi.fn().mockResolvedValue(undefined),
}));

import { createGracefulShutdownHandler } from '../server';

describe('Graceful Process Shutdown Handler for API and Watcher (#536)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes SSE streams, Fastify server, gRPC server, Prisma, Telemetry, and Redis cleanly on SIGTERM and exits 0', async () => {
    const callOrder: string[] = [];
    const appClose = vi.fn(async () => {
      callOrder.push('app.close');
    });
    const grpcStop = vi.fn(() => {
      callOrder.push('grpc.stop');
    });
    const closeSseStreams = vi.fn(async () => {
      callOrder.push('sse.close');
    });
    const prismaDisconnect = vi.fn(async () => {
      callOrder.push('prisma.disconnect');
    });
    const shutdownTelemetryFn = vi.fn(async () => {
      callOrder.push('telemetry.shutdown');
    });
    const closeRedisFn = vi.fn(async () => {
      callOrder.push('redis.close');
    });
    const exitFn = vi.fn();

    const shutdown = createGracefulShutdownHandler({
      app: { close: appClose },
      grpcServer: { stop: grpcStop },
      closeSseStreams,
      prismaClient: { $disconnect: prismaDisconnect },
      shutdownTelemetryFn,
      closeRedisFn,
      exitFn,
      timeoutMs: 5000,
    });

    await shutdown('SIGTERM');

    expect(callOrder).toEqual([
      'grpc.stop',
      'sse.close',
      'app.close',
      'prisma.disconnect',
      'telemetry.shutdown',
      'redis.close',
    ]);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('ignores duplicate SIGINT signals while shutdown is already in progress', async () => {
    const appClose = vi.fn().mockResolvedValue(undefined);
    const prismaDisconnect = vi.fn().mockResolvedValue(undefined);
    const exitFn = vi.fn();

    const shutdown = createGracefulShutdownHandler({
      app: { close: appClose },
      prismaClient: { $disconnect: prismaDisconnect },
      exitFn,
    });

    await Promise.all([shutdown('SIGINT'), shutdown('SIGTERM')]);

    expect(appClose).toHaveBeenCalledTimes(1);
    expect(prismaDisconnect).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledTimes(1);
    expect(exitFn).toHaveBeenCalledWith(0);
  });

  it('forcefully exits with code 1 if connections fail to close within 5 seconds', async () => {
    const neverResolves = new Promise<void>(() => {});
    const exitFn = vi.fn();

    const shutdown = createGracefulShutdownHandler({
      app: { close: () => neverResolves },
      exitFn,
      timeoutMs: 5000,
    });

    void shutdown('SIGTERM');

    await vi.advanceTimersByTimeAsync(4999);
    expect(exitFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(exitFn).toHaveBeenCalledWith(1);
  });
});
