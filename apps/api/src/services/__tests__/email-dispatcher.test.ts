import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResendSend } = vi.hoisted(() => ({
  mockResendSend: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: mockResendSend,
    },
  })),
}));

import {
  dispatchEmailNotification,
  buildStellarExpertTxUrl,
} from '../email.service';

describe('Email Notification Worker Dispatcher via Resend API (#535)', () => {
  const samplePayment = {
    recipientEmail: 'merchant@stellar-alerts.org',
    emailEnabled: true,
    paymentId: 'pay-535',
    txHash: 'c'.repeat(64),
    amount: '1500.5000000',
    asset: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    fromAddress: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    receivedAt: '2026-03-30T15:30:00.000Z',
    apiKey: 're_test_dispatcher_535',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a valid Stellar Expert transaction explorer URL', () => {
    expect(buildStellarExpertTxUrl(samplePayment.txHash, 'testnet')).toBe(
      `https://stellar.expert/explorer/testnet/tx/${samplePayment.txHash}`,
    );
  });

  it('dispatches a clean HTML email via Resend API when emailEnabled is true', async () => {
    mockResendSend.mockResolvedValueOnce({
      data: { id: 'resend-msg-535' },
      error: null,
    });

    const result = await dispatchEmailNotification(samplePayment);

    expect(result).toEqual({ sent: true, id: 'resend-msg-535' });
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    expect(mockResendSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['merchant@stellar-alerts.org'],
        subject: '[Stellar Alerts] Payment Received: 1500.5000000 USDC',
        html: expect.stringContaining('1500.5000000 USDC'),
      }),
    );
    const sentPayload = mockResendSend.mock.calls[0][0] as { html: string };
    expect(sentPayload.html).toContain(samplePayment.fromAddress);
    expect(sentPayload.html).toContain(samplePayment.txHash);
  });

  it('skips email dispatch when emailEnabled is false', async () => {
    const result = await dispatchEmailNotification({
      ...samplePayment,
      emailEnabled: false,
    });

    expect(result).toEqual({ sent: false, skipped: true });
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('logs delivery failure without crashing the worker process when Resend returns an error', async () => {
    mockResendSend.mockResolvedValueOnce({
      data: null,
      error: { statusCode: 503, message: 'Resend upstream unavailable' },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await dispatchEmailNotification(samplePayment);

    expect(result.sent).toBe(false);
    expect(result.error).toContain('Resend upstream unavailable');
    expect(errorSpy).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
