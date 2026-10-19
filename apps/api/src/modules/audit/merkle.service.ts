import { prisma } from '../../lib/prisma';
import { createLogger } from '../../lib/logger';
import {
  AlertAuditRecord,
  MerkleAuditService,
  merkleAuditService,
  MerkleProof,
  MerkleTree,
} from '@stellar-alerts/shared';

const log = createLogger({ module: 'AuditMerkleService' });

export function toUtcDayString(date: Date): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export interface DailyAlertMerkleResult {
  date: string;
  root: string;
  leafCount: number;
}

export interface AlertProofResult {
  alert: AlertAuditRecord;
  root: string;
  proof: MerkleProof;
  date: string;
}

export class ApiMerkleAuditService {
  private auditEngine: MerkleAuditService;

  constructor(auditEngine: MerkleAuditService = merkleAuditService) {
    this.auditEngine = auditEngine;
  }

  /**
   * Fetches delivered alert records for a specific UTC calendar day.
   */
  public async getAlertRecordsForDate(day: Date | string): Promise<AlertAuditRecord[]> {
    const dayDate = typeof day === 'string' ? new Date(day) : day;
    const dateStr = toUtcDayString(dayDate);
    const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
    const dayEnd = new Date(`${dateStr}T23:59:59.999Z`);

    const deliveries = await prisma.notificationDelivery.findMany({
      where: {
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (deliveries.length > 0) {
      return deliveries.map((d) => ({
        id: d.id,
        channel: d.channel,
        destination: d.destination,
        status: d.status,
        paymentId: d.paymentId,
        error: d.lastError ?? null,
        deliveredAt: d.deliveredAt,
        createdAt: d.createdAt,
      }));
    }

    // Fallback: check DeliveryLog table if NotificationDelivery has no entries for that day
    const deliveryLogs = await prisma.deliveryLog.findMany({
      where: {
        createdAt: { gte: dayStart, lte: dayEnd },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return deliveryLogs.map((l) => ({
      id: l.id,
      channel: l.channel,
      destination: 'N/A',
      status: l.status,
      paymentId: l.paymentId,
      error: l.error ?? null,
      deliveredAt: null,
      createdAt: l.createdAt,
    }));
  }

  /**
   * Computes a cryptographic Merkle root over all alert deliveries on the given date.
   */
  public async computeDailyAlertMerkleRoot(
    day: Date | string = new Date()
  ): Promise<DailyAlertMerkleResult | null> {
    const dayDate = typeof day === 'string' ? new Date(day) : day;
    const dateStr = toUtcDayString(dayDate);
    const records = await this.getAlertRecordsForDate(dayDate);

    if (records.length === 0) {
      log.info({ date: dateStr }, 'ℹ️ No alert delivery logs found for date');
      return null;
    }

    const tree = this.auditEngine.buildTree(records);
    log.info(
      { date: dateStr, leafCount: records.length, root: tree.root },
      '✅ Computed daily alert delivery Merkle root'
    );

    return {
      date: dateStr,
      root: tree.root,
      leafCount: records.length,
    };
  }

  /**
   * Generates a compact inclusion proof for a specific alert record.
   */
  public async generateAlertProof(
    alertId: string,
    day?: Date | string
  ): Promise<AlertProofResult | null> {
    let targetDate: Date | null = day ? (typeof day === 'string' ? new Date(day) : day) : null;

    if (!targetDate) {
      // Find the alert to determine its creation date
      const delivery = await prisma.notificationDelivery.findUnique({
        where: { id: alertId },
      });
      if (delivery) {
        targetDate = delivery.createdAt;
      } else {
        const logEntry = await prisma.deliveryLog.findUnique({
          where: { id: alertId },
        });
        if (logEntry) {
          targetDate = logEntry.createdAt;
        }
      }
    }

    if (!targetDate) {
      return null;
    }

    const records = await this.getAlertRecordsForDate(targetDate);
    const alertRecord = records.find((r) => r.id === alertId);
    if (!alertRecord) {
      return null;
    }

    const tree = this.auditEngine.buildTree(records);
    const proof = this.auditEngine.generateProof(records, alertId);
    if (!proof) {
      return null;
    }

    return {
      alert: alertRecord,
      root: tree.root,
      proof,
      date: toUtcDayString(targetDate),
    };
  }

  /**
   * Verifies proof against expected root independently.
   */
  public verifyProof(proof: MerkleProof, expectedRoot: string): boolean {
    return this.auditEngine.verifyProof(proof, expectedRoot);
  }

  /**
   * Verifies an alert record and its inclusion proof against the expected root.
   */
  public verifyRecordInclusion(
    record: AlertAuditRecord,
    proof: MerkleProof,
    expectedRoot: string
  ): boolean {
    return this.auditEngine.verifyRecordInclusion(record, proof, expectedRoot);
  }
}

export const apiMerkleAuditService = new ApiMerkleAuditService();
