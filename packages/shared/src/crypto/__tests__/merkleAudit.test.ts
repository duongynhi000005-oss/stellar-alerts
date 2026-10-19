import { describe, it, expect } from 'vitest';
import {
  AlertAuditRecord,
  canonicalizeAlertRecord,
  computeAlertLeafHash,
  MerkleAuditService,
  merkleAuditService,
} from '../merkle';

describe('MerkleAuditService - Cryptographic Alert Audit Logs', () => {
  const sampleRecords: AlertAuditRecord[] = [
    {
      id: 'alert-1',
      channel: 'webhook',
      destination: 'https://api.example.com/hooks/stellar',
      status: 'delivered',
      paymentId: 'pay-100',
      error: null,
      deliveredAt: '2026-10-19T10:00:00.000Z',
      createdAt: '2026-10-19T09:59:50.000Z',
    },
    {
      id: 'alert-2',
      channel: 'email',
      destination: 'auditor@example.com',
      status: 'delivered',
      paymentId: 'pay-101',
      error: null,
      deliveredAt: '2026-10-19T10:05:00.000Z',
      createdAt: '2026-10-19T10:04:30.000Z',
    },
    {
      id: 'alert-3',
      channel: 'telegram',
      destination: 'tg:12345678',
      status: 'failed',
      paymentId: 'pay-102',
      error: 'Connection timeout',
      deliveredAt: null,
      createdAt: '2026-10-19T10:10:00.000Z',
    },
  ];

  it('generates deterministic and canonical serialization for records', () => {
    const record = sampleRecords[0];
    const canonical = canonicalizeAlertRecord(record);

    expect(canonical).toBe(
      'alert-1|webhook|https://api.example.com/hooks/stellar|delivered|pay-100|N/A|2026-10-19T10:00:00.000Z|2026-10-19T09:59:50.000Z'
    );

    const hash1 = computeAlertLeafHash(record);
    const hash2 = merkleAuditService.hashRecord(record);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('constructs a standard binary Merkle tree over alert delivery records', () => {
    const tree = merkleAuditService.buildTree(sampleRecords);

    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);
    expect(tree.layers.length).toBeGreaterThanOrEqual(2);
    expect(tree.layers[0].length).toBe(3);
    expect(tree.layers[0][0]).toBe(computeAlertLeafHash(sampleRecords[0]));
    expect(tree.layers[0][1]).toBe(computeAlertLeafHash(sampleRecords[1]));
    expect(tree.layers[0][2]).toBe(computeAlertLeafHash(sampleRecords[2]));
  });

  it('throws when building Merkle tree from empty records list', () => {
    expect(() => merkleAuditService.buildTree([])).toThrow(
      'Cannot construct Merkle tree from empty records'
    );
  });

  it('generates compact Merkle inclusion proof for each alert ID and verifies successfully', () => {
    const tree = merkleAuditService.buildTree(sampleRecords);

    for (const record of sampleRecords) {
      const proof = merkleAuditService.generateProof(sampleRecords, record.id);
      expect(proof).not.toBeNull();
      if (!proof) return;

      expect(proof.leafHash).toBe(computeAlertLeafHash(record));
      expect(Array.isArray(proof.path)).toBe(true);

      // Verify proof independently
      const isValid = merkleAuditService.verifyProof(proof, tree.root);
      expect(isValid).toBe(true);

      // Verify record inclusion directly
      const isRecordIncluded = merkleAuditService.verifyRecordInclusion(record, proof, tree.root);
      expect(isRecordIncluded).toBe(true);
    }
  });

  it('returns null when generating proof for non-existent alert ID', () => {
    const proof = merkleAuditService.generateProof(sampleRecords, 'non-existent-id');
    expect(proof).toBeNull();
  });

  it('rejects inclusion proof if record payload has been tampered with', () => {
    const tree = merkleAuditService.buildTree(sampleRecords);
    const targetRecord = sampleRecords[0];
    const proof = merkleAuditService.generateProof(sampleRecords, targetRecord.id)!;

    // Tamper 1: change delivery status (e.g. attacker claims failed alert was delivered)
    const tamperedRecord1: AlertAuditRecord = {
      ...targetRecord,
      status: 'failed',
    };
    expect(merkleAuditService.verifyRecordInclusion(tamperedRecord1, proof, tree.root)).toBe(false);

    // Tamper 2: change destination
    const tamperedRecord2: AlertAuditRecord = {
      ...targetRecord,
      destination: 'https://attacker.example.com',
    };
    expect(merkleAuditService.verifyRecordInclusion(tamperedRecord2, proof, tree.root)).toBe(false);

    // Tamper 3: change timestamp
    const tamperedRecord3: AlertAuditRecord = {
      ...targetRecord,
      createdAt: '2026-10-19T00:00:00.000Z',
    };
    expect(merkleAuditService.verifyRecordInclusion(tamperedRecord3, proof, tree.root)).toBe(false);
  });

  it('rejects inclusion proof if Merkle root has been tampered with', () => {
    const targetRecord = sampleRecords[1];
    const proof = merkleAuditService.generateProof(sampleRecords, targetRecord.id)!;
    const fakeRoot = 'a'.repeat(64);

    expect(merkleAuditService.verifyProof(proof, fakeRoot)).toBe(false);
    expect(merkleAuditService.verifyRecordInclusion(targetRecord, proof, fakeRoot)).toBe(false);
  });

  it('rejects inclusion proof if sibling path is tampered with', () => {
    const tree = merkleAuditService.buildTree(sampleRecords);
    const targetRecord = sampleRecords[0];
    const proof = merkleAuditService.generateProof(sampleRecords, targetRecord.id)!;

    // Corrupt one sibling hash
    const corruptedProof = {
      ...proof,
      path: proof.path.map((step, idx) =>
        idx === 0
          ? { ...step, siblingHash: 'b'.repeat(64) }
          : step
      ),
    };

    expect(merkleAuditService.verifyProof(corruptedProof, tree.root)).toBe(false);
    expect(merkleAuditService.verifyRecordInclusion(targetRecord, corruptedProof, tree.root)).toBe(
      false
    );
  });

  it('handles power-of-two and odd record counts correctly', () => {
    // 1 record
    const single = [sampleRecords[0]];
    const tree1 = merkleAuditService.buildTree(single);
    const proof1 = merkleAuditService.generateProof(single, single[0].id)!;
    expect(merkleAuditService.verifyRecordInclusion(single[0], proof1, tree1.root)).toBe(true);

    // 2 records
    const double = [sampleRecords[0], sampleRecords[1]];
    const tree2 = merkleAuditService.buildTree(double);
    const proof2 = merkleAuditService.generateProof(double, double[1].id)!;
    expect(merkleAuditService.verifyRecordInclusion(double[1], proof2, tree2.root)).toBe(true);

    // 4 records
    const quad = [
      ...sampleRecords,
      {
        id: 'alert-4',
        channel: 'slack',
        destination: '#ops-alerts',
        status: 'delivered',
        createdAt: '2026-10-19T11:00:00.000Z',
      },
    ];
    const tree4 = merkleAuditService.buildTree(quad);
    for (const r of quad) {
      const p = merkleAuditService.generateProof(quad, r.id)!;
      expect(merkleAuditService.verifyRecordInclusion(r, p, tree4.root)).toBe(true);
    }
  });
});
