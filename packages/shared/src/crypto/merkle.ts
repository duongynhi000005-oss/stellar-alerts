import * as crypto from 'crypto';
import {
  hashMerkleLeaf,
  hashMerkleNode,
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  computeMerkleRoot,
  MerkleProof,
  MerkleProofStep,
  MerkleTree,
} from '../merkle';

export type { MerkleProof, MerkleProofStep, MerkleTree };

export interface AlertAuditRecord {
  id: string;
  channel: string;
  destination: string;
  status: string;
  paymentId?: string | null;
  error?: string | null;
  deliveredAt?: Date | string | null;
  createdAt: Date | string;
}

/**
 * Order-stable canonical serialization of an alert delivery record.
 * Formatted with pipe-delimiters and ISO timestamps for deterministic hashing.
 */
export function canonicalizeAlertRecord(record: AlertAuditRecord): string {
  const deliveredAtStr = record.deliveredAt
    ? new Date(record.deliveredAt).toISOString()
    : 'N/A';
  const createdAtStr = new Date(record.createdAt).toISOString();

  return [
    record.id,
    record.channel,
    record.destination,
    record.status,
    record.paymentId ?? 'N/A',
    record.error ?? 'N/A',
    deliveredAtStr,
    createdAtStr,
  ].join('|');
}

/**
 * Converts canonical alert record representation into a UTF-8 Buffer.
 */
export function computeAlertLeafBuffer(record: AlertAuditRecord): Buffer {
  return Buffer.from(canonicalizeAlertRecord(record), 'utf8');
}

/**
 * Computes domain-separated SHA-256 leaf hash for an alert audit record.
 */
export function computeAlertLeafHash(record: AlertAuditRecord): string {
  return hashMerkleLeaf(computeAlertLeafBuffer(record));
}

/**
 * Cryptographic Merkle tree service for tamper-evident historical audit logs.
 */
export class MerkleAuditService {
  /**
   * Hashes an alert audit record deterministically.
   */
  public hashRecord(record: AlertAuditRecord): string {
    return computeAlertLeafHash(record);
  }

  /**
   * Constructs a standard binary Merkle tree using domain-separated SHA-256
   * over an array of alert delivery records.
   */
  public buildTree(records: AlertAuditRecord[]): MerkleTree {
    if (!records || records.length === 0) {
      throw new Error('Cannot construct Merkle tree from empty records');
    }
    const leafBuffers = records.map((record) => computeAlertLeafBuffer(record));
    return buildMerkleTree(leafBuffers);
  }

  /**
   * Generates a compact Merkle inclusion proof (path sibling hashes) for a specific alert ID.
   * Returns null if the alert record is not found in the input list.
   */
  public generateProof(records: AlertAuditRecord[], alertId: string): MerkleProof | null {
    if (!records || records.length === 0) {
      return null;
    }

    const index = records.findIndex((r) => r.id === alertId);
    if (index === -1) {
      return null;
    }

    const tree = this.buildTree(records);
    const leafHash = computeAlertLeafHash(records[index]);
    const path = generateMerkleProof(tree, index);

    return {
      leafHash,
      path,
    };
  }

  /**
   * Verifies a Merkle inclusion proof against an expected root hash.
   */
  public verifyProof(proof: MerkleProof, expectedRoot: string): boolean {
    return verifyMerkleProof(proof, expectedRoot);
  }

  /**
   * Validates that an alert record matches the proof's leaf hash and that the proof
   * cryptographically recomputes to the expected daily Merkle root.
   */
  public verifyRecordInclusion(
    record: AlertAuditRecord,
    proof: MerkleProof,
    expectedRoot: string
  ): boolean {
    if (!proof || !record || !expectedRoot) {
      return false;
    }

    const expectedLeafHash = this.hashRecord(record);
    if (proof.leafHash.toLowerCase() !== expectedLeafHash.toLowerCase()) {
      return false;
    }

    return this.verifyProof(proof, expectedRoot);
  }
}

export const merkleAuditService = new MerkleAuditService();
