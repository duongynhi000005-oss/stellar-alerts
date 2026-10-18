import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockFindUniqueCursor,
  mockUpsertCursor,
  mockPaymentFindUnique,
  mockPaymentCreate,
} = vi.hoisted(() => ({
  mockFindUniqueCursor: vi.fn(),
  mockUpsertCursor: vi.fn().mockResolvedValue({}),
  mockPaymentFindUnique: vi.fn().mockResolvedValue(null),
  mockPaymentCreate: vi.fn().mockResolvedValue({ id: 'pay-538' }),
}));

vi.mock('../../lib/queue', () => ({
  alertQueue: {
    add: vi.fn().mockResolvedValue({ id: 'job-538' }),
  },
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    ingestionCursor: {
      findUnique: (...args: unknown[]) => mockFindUniqueCursor(...args),
      upsert: (...args: unknown[]) => mockUpsertCursor(...args),
      create: vi.fn().mockResolvedValue({ pagingToken: '1000' }),
    },
    payment: {
      findUnique: (...args: unknown[]) => mockPaymentFindUnique(...args),
      create: (...args: unknown[]) => mockPaymentCreate(...args),
    },
    wallet: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock('../../lib/stellar', () => ({
  stellar: {
    getLatestPagingToken: vi.fn().mockResolvedValue('1000'),
    server: {
      payments: vi.fn(),
    },
  },
}));

import { startHorizonSSEStream, streamMetrics, type StreamHandlerOptions } from '../watcher.worker';

describe('Horizon SSE Stream Heartbeat & Auto-Reconnect Fallback (#538)', () => {
  const validWallet = {
    id: 'wallet-538',
    publicKey: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    streamMetrics.reconnects = 0;
    streamMetrics.heartbeatTimeouts = 0;
    streamMetrics.messagesProcessed = 0;
    streamMetrics.backpressureDropped = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes silent zombie SSE stream after 60s heartbeat timeout and reconnects from latest persisted cursor', async () => {
    mockFindUniqueCursor
      .mockResolvedValueOnce({ walletId: validWallet.id, pagingToken: 'cursor-100' })
      .mockResolvedValueOnce({ walletId: validWallet.id, pagingToken: 'cursor-200' });

    const closeSpies: Array<ReturnType<typeof vi.fn>> = [];
    const connectedCursors: string[] = [];

    const connector = vi.fn((cursor: string, _handlers: StreamHandlerOptions) => {
      connectedCursors.push(cursor);
      const closeFn = vi.fn();
      closeSpies.push(closeFn);
      return closeFn;
    });

    const stopStream = await startHorizonSSEStream(validWallet, {
      connector,
      heartbeatTimeoutMs: 60000,
    });

    expect(connector).toHaveBeenCalledTimes(1);
    expect(connectedCursors).toEqual(['cursor-100']);

    // Advance 59 seconds: stream should still be open without timeout
    await vi.advanceTimersByTimeAsync(59000);
    expect(streamMetrics.heartbeatTimeouts).toBe(0);
    expect(closeSpies[0]).not.toHaveBeenCalled();

    // Advance past 60 seconds: heartbeat timeout fires, closes first stream, and reconnects from cursor-200
    await vi.advanceTimersByTimeAsync(1000);

    expect(streamMetrics.heartbeatTimeouts).toBe(1);
    expect(streamMetrics.reconnects).toBe(1);
    expect(closeSpies[0]).toHaveBeenCalledTimes(1);
    expect(connector).toHaveBeenCalledTimes(2);
    expect(connectedCursors).toEqual(['cursor-100', 'cursor-200']);

    stopStream();
    expect(closeSpies[1]).toHaveBeenCalledTimes(1);
  });

  it('resets the 60s heartbeat timer whenever a live SSE message arrives', async () => {
    mockFindUniqueCursor.mockResolvedValue({ walletId: validWallet.id, pagingToken: '4294967296' });

    let capturedHandlers: StreamHandlerOptions | null = null;
    const connector = vi.fn((_cursor: string, handlers: StreamHandlerOptions) => {
      capturedHandlers = handlers;
      return vi.fn();
    });

    const stopStream = await startHorizonSSEStream(validWallet, {
      connector,
      heartbeatTimeoutMs: 60000,
    });

    // Advance 40s, then emit a message -> timer resets to full 60s
    await vi.advanceTimersByTimeAsync(40000);
    expect(capturedHandlers).not.toBeNull();
    await capturedHandlers!.onmessage({
      id: 'op-538',
      paging_token: '4294967297',
      type: 'payment',
      transaction_successful: true,
      transaction_hash: 'b'.repeat(64),
      from: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      to: validWallet.publicKey,
      amount: '10.0000000',
      asset_type: 'native',
      created_at: '2026-03-30T12:00:00Z',
    });

    // Advance another 40s (80s total, but only 40s since last message): no timeout!
    await vi.advanceTimersByTimeAsync(40000);
    expect(streamMetrics.heartbeatTimeouts).toBe(0);
    expect(connector).toHaveBeenCalledTimes(1);

    stopStream();
  });
});
