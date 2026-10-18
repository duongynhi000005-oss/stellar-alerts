import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConnect, mockDisconnect } = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockDisconnect: vi.fn(),
}));

vi.mock('../../../generated/prisma/client', () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    $connect: mockConnect,
    $disconnect: mockDisconnect,
  })),
}));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: vi.fn().mockImplementation((cfg: unknown) => cfg),
}));

import { connectWithRetry } from '../prisma';

describe('Database Connection Retry Strategy with Exponential Backoff (#537)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('connects immediately on the first attempt without backoff delay', async () => {
    mockConnect.mockResolvedValueOnce(undefined);
    const sleepSpy = vi.fn().mockResolvedValue(undefined);

    await connectWithRetry(5, 1000, sleepSpy);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('retries with exponential backoff (1000ms, 2000ms, 4000ms) and recovers on attempt 4', async () => {
    mockConnect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))
      .mockResolvedValueOnce(undefined);

    const delays: number[] = [];
    const sleepSpy = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await connectWithRetry(5, 1000, sleepSpy);

    expect(mockConnect).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it('throws a fatal error after exhausting all 5 attempts', async () => {
    mockConnect.mockRejectedValue(new Error('PostgreSQL database is starting up'));

    const delays: number[] = [];
    const sleepSpy = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(connectWithRetry(5, 1000, sleepSpy)).rejects.toThrow(
      'Failed to connect to PostgreSQL after 5 attempts: PostgreSQL database is starting up',
    );

    expect(mockConnect).toHaveBeenCalledTimes(5);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
