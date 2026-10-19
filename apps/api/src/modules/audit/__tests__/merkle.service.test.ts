import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    notificationDelivery: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    deliveryLog: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { prisma } from '../../../lib/prisma';
import { ApiMerkleAuditService, toUtcDayString } from '../merkle.service';
import { auditController } from '../audit.controller';

describe('ApiMerkleAuditService & AuditController', () => {
  let service: ApiMerkleAuditService;

  const sampleDate = '2026-10-19';
  const mockDeliveries = [
    {
      id: 'deliv-1',
      channel: 'webhook',
      destination: 'https://example.com/webhook',
      status: 'delivered',
      paymentId: 'pay-001',
      lastError: null,
      deliveredAt: new Date('2026-10-19T10:00:00Z'),
      createdAt: new Date('2026-10-19T09:59:00Z'),
    },
    {
      id: 'deliv-2',
      channel: 'email',
      destination: 'admin@stellar.org',
      status: 'delivered',
      paymentId: 'pay-002',
      lastError: null,
      deliveredAt: new Date('2026-10-19T11:00:00Z'),
      createdAt: new Date('2026-10-19T10:55:00Z'),
    },
    {
      id: 'deliv-3',
      channel: 'telegram',
      destination: 'tg:999999',
      status: 'failed',
      paymentId: 'pay-003',
      lastError: 'Blocked by bot policy',
      deliveredAt: null,
      createdAt: new Date('2026-10-19T12:00:00Z'),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ApiMerkleAuditService();
  });

  it('formats UTC day string accurately', () => {
    expect(toUtcDayString(new Date('2026-10-19T23:59:59.999Z'))).toBe('2026-10-19');
  });

  describe('computeDailyAlertMerkleRoot', () => {
    it('returns null when no alert deliveries exist for the target date', async () => {
      (prisma.notificationDelivery.findMany as any).mockResolvedValue([]);
      (prisma.deliveryLog.findMany as any).mockResolvedValue([]);

      const result = await service.computeDailyAlertMerkleRoot(sampleDate);
      expect(result).toBeNull();
    });

    it('computes daily root and leaf count correctly from notification deliveries', async () => {
      (prisma.notificationDelivery.findMany as any).mockResolvedValue(mockDeliveries);

      const result = await service.computeDailyAlertMerkleRoot(sampleDate);
      expect(result).not.toBeNull();
      expect(result?.date).toBe(sampleDate);
      expect(result?.leafCount).toBe(3);
      expect(result?.root).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('generateAlertProof & verification', () => {
    it('generates an inclusion proof and validates it cryptographically against root', async () => {
      (prisma.notificationDelivery.findUnique as any).mockResolvedValue(mockDeliveries[0]);
      (prisma.notificationDelivery.findMany as any).mockResolvedValue(mockDeliveries);

      const proofResult = await service.generateAlertProof('deliv-1');
      expect(proofResult).not.toBeNull();
      expect(proofResult?.alert.id).toBe('deliv-1');
      expect(proofResult?.proof.path.length).toBeGreaterThan(0);

      const isValid = service.verifyProof(proofResult!.proof, proofResult!.root);
      expect(isValid).toBe(true);

      const isRecordValid = service.verifyRecordInclusion(
        proofResult!.alert,
        proofResult!.proof,
        proofResult!.root
      );
      expect(isRecordValid).toBe(true);
    });

    it('rejects verification if alert payload is modified', async () => {
      (prisma.notificationDelivery.findUnique as any).mockResolvedValue(mockDeliveries[0]);
      (prisma.notificationDelivery.findMany as any).mockResolvedValue(mockDeliveries);

      const proofResult = await service.generateAlertProof('deliv-1');
      expect(proofResult).not.toBeNull();

      const tamperedAlert = {
        ...proofResult!.alert,
        status: 'tampered-status',
      };

      const isRecordValid = service.verifyRecordInclusion(
        tamperedAlert,
        proofResult!.proof,
        proofResult!.root
      );
      expect(isRecordValid).toBe(false);
    });

    it('returns null if alert record is not found', async () => {
      (prisma.notificationDelivery.findUnique as any).mockResolvedValue(null);
      (prisma.deliveryLog.findUnique as any).mockResolvedValue(null);

      const proofResult = await service.generateAlertProof('missing-alert-id');
      expect(proofResult).toBeNull();
    });
  });

  describe('AuditController handlers', () => {
    it('getDailyRoot returns 404 when no records found', async () => {
      (prisma.notificationDelivery.findMany as any).mockResolvedValue([]);
      (prisma.deliveryLog.findMany as any).mockResolvedValue([]);

      const mockReply: any = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
      };

      await auditController.getDailyRoot({ query: { date: '2026-10-19' } } as any, mockReply);
      expect(mockReply.status).toHaveBeenCalledWith(404);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({ success: false })
      );
    });

    it('getDailyRoot returns 200 with computed root when records exist', async () => {
      (prisma.notificationDelivery.findMany as any).mockResolvedValue(mockDeliveries);

      const mockReply: any = {
        send: vi.fn().mockReturnThis(),
      };

      await auditController.getDailyRoot({ query: { date: '2026-10-19' } } as any, mockReply);
      expect(mockReply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ leafCount: 3 }),
        })
      );
    });

    it('verifyProof returns valid: true for untampered proof and valid: false for bad root', async () => {
      (prisma.notificationDelivery.findUnique as any).mockResolvedValue(mockDeliveries[0]);
      (prisma.notificationDelivery.findMany as any).mockResolvedValue(mockDeliveries);

      const proofResult = await service.generateAlertProof('deliv-1');
      const mockReply: any = {
        send: vi.fn().mockReturnThis(),
      };

      // Valid proof
      await auditController.verifyProof(
        {
          body: {
            root: proofResult!.root,
            proof: proofResult!.proof,
            record: proofResult!.alert,
          },
        } as any,
        mockReply
      );
      expect(mockReply.send).toHaveBeenCalledWith({ success: true, valid: true });

      // Tampered root
      await auditController.verifyProof(
        {
          body: {
            root: 'f'.repeat(64),
            proof: proofResult!.proof,
            record: proofResult!.alert,
          },
        } as any,
        mockReply
      );
      expect(mockReply.send).toHaveBeenCalledWith({ success: true, valid: false });
    });
  });
});
