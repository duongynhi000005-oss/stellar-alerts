import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Job } from 'bullmq';

const {
  mockDlqAdd,
  mockPersistDeadLetter,
  mockWalletFindUnique,
  mockDeadLetterFindUnique,
  mockDeadLetterUpdate,
} = vi.hoisted(() => ({
  mockDlqAdd: vi.fn().mockResolvedValue({ id: 'dlq-job-101' }),
  mockPersistDeadLetter: vi.fn().mockResolvedValue('dead-letter-row-1'),
  mockWalletFindUnique: vi.fn().mockResolvedValue({ userId: 'user-539' }),
  mockDeadLetterFindUnique: vi.fn(),
  mockDeadLetterUpdate: vi.fn(),
}));

vi.mock('../../utils/crypto-vault', () => ({
  cryptoVault: {
    encrypt: vi.fn(),
    decrypt: vi.fn().mockReturnValue('secret'),
  },
}));

vi.mock('../../utils/rate-limiter', () => ({
  adaptiveWebhookRateLimiter: {
    getDelay: vi.fn().mockReturnValue(0),
    handleRateLimitResponse: vi.fn(),
  },
  waitForAdaptiveBackoff: vi.fn().mockResolvedValue(0),
}));

vi.mock('bullmq', () => {
  const MockQueue = vi.fn().mockImplementation((name: string, opts?: unknown) => ({
    name,
    opts,
    add: name === 'payment-alerts-dlq' ? mockDlqAdd : vi.fn(),
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }));
  const MockQueueEvents = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }));
  const MockWorker = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }));
  return {
    Queue: MockQueue,
    QueueEvents: MockQueueEvents,
    Worker: MockWorker,
    Job: {
      fromId: vi.fn(),
    },
  };
});

vi.mock('../prisma', () => ({
  prisma: {
    wallet: {
      findUnique: (...args: unknown[]) => mockWalletFindUnique(...args),
    },
    deadLetter: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'dlq-db-1' }),
      findUnique: (...args: unknown[]) => mockDeadLetterFindUnique(...args),
      update: (...args: unknown[]) => mockDeadLetterUpdate(...args),
    },
  },
}));

vi.mock('../dead-letter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dead-letter')>();
  return {
    ...actual,
    persistDeadLetter: (...args: unknown[]) => mockPersistDeadLetter(...args),
  };
});

import { failedJobHandler, alertQueue } from '../queue';
import { replayDeadLetterJob } from '../dead-letter';

describe('Dead Letter Queue (DLQ) for Failed Notification Dispatches (#539)', () => {
  const sampleJobData = {
    paymentId: 'pay-539',
    txHash: 'a'.repeat(64),
    walletId: 'wallet-539',
    amount: '250.0000000',
    asset: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    fromAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    receivedAt: '2026-03-30T10:00:00.000Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures payment-alerts queue with 5 retry attempts and exponential backoff', () => {
    const queueOpts = (alertQueue as unknown as { opts?: { defaultJobOptions?: { attempts?: number; backoff?: { type: string; delay: number } } } })?.opts;
    expect(queueOpts?.defaultJobOptions?.attempts).toBe(5);
    expect(queueOpts?.defaultJobOptions?.backoff).toEqual({
      type: 'exponential',
      delay: 2000,
    });
  });

  it('simulates 5 consecutive transient failures and moves the job to DLQ only on attempt 5', async () => {
    for (let attempt = 1; attempt <= 4; attempt++) {
      vi.mocked(Job.fromId).mockResolvedValueOnce({
        id: 'job-101',
        data: sampleJobData,
        attemptsMade: attempt,
        opts: { attempts: 5 },
      } as unknown as Job);

      await failedJobHandler({
        jobId: 'job-101',
        failedReason: 'HTTP 503 Service Unavailable',
      });
    }

    expect(mockDlqAdd).not.toHaveBeenCalled();
    expect(mockPersistDeadLetter).not.toHaveBeenCalled();

    // 5th consecutive failure exhausts attempts
    vi.mocked(Job.fromId).mockResolvedValueOnce({
      id: 'job-101',
      data: sampleJobData,
      attemptsMade: 5,
      opts: { attempts: 5 },
    } as unknown as Job);

    await failedJobHandler({
      jobId: 'job-101',
      failedReason: 'HTTP 503 Service Unavailable',
    });

    expect(mockDlqAdd).toHaveBeenCalledTimes(1);
    expect(mockDlqAdd).toHaveBeenCalledWith(
      'dispatch-alert-failed',
      sampleJobData,
      { jobId: 'dlq-job-101' },
    );
    expect(mockPersistDeadLetter).toHaveBeenCalledTimes(1);
    expect(mockPersistDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'queue',
        destination: 'job-101',
        deliveryKey: 'queue:job-101',
        paymentId: 'pay-539',
        userId: 'user-539',
        failureReason: 'max_attempts_exceeded',
        attemptsMade: 5,
        maxAttempts: 5,
      }),
    );
  });

  it('supports manual replay of quarantined dead-letter jobs', async () => {
    mockDeadLetterFindUnique.mockResolvedValueOnce({
      id: 'dlq-row-539',
      status: 'pending',
      channel: 'queue',
      payload: sampleJobData,
    });
    mockDeadLetterUpdate.mockResolvedValueOnce({ id: 'dlq-row-539', status: 'replayed' });

    const enqueueSpy = vi.fn().mockResolvedValue(undefined);
    const replayed = await replayDeadLetterJob('dlq-row-539', enqueueSpy);

    expect(replayed).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledWith(sampleJobData);
    expect(mockDeadLetterUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dlq-row-539' },
        data: expect.objectContaining({ status: 'replayed' }),
      }),
    );
  });
});
