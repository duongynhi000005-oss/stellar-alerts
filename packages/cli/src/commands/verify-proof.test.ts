import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildMerkleTree,
  generateMerkleProof,
  hashMerkleLeaf,
} from '@stellar-alerts/shared';
import {
  executeVerifyProof,
  parseProofStep,
  parseProofSteps,
} from '../lib/merkle-verifier.js';

describe('merkle-verifier & alerts verify-proof', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merkle-proof-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses proof steps from strings, directions, and objects', () => {
    const step1 = parseProofStep('left:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(step1.direction).toBe('left');
    expect(step1.siblingHash).toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

    const step2 = parseProofStep('right:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(step2.direction).toBe('right');

    const step3 = parseProofStep('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    expect(step3.direction).toBe('right');

    const step4 = parseProofStep({
      hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      direction: 'left',
    });
    expect(step4.direction).toBe('left');

    const steps = parseProofSteps([
      'left:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      'right:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
    ]);
    expect(steps.length).toBe(2);
    expect(steps[0].direction).toBe('left');
    expect(steps[1].direction).toBe('right');
  });

  it('verifies authentic 4-hop Merkle proof (16 leaves)', () => {
    // 2^4 = 16 leaves -> 4 hops
    const rawLeaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`alert-leaf-record-data-${i}`),
    );
    const tree = buildMerkleTree(rawLeaves);
    expect(tree.layers.length).toBe(5); // 16 -> 8 -> 4 -> 2 -> 1 root

    const targetIndex = 5;
    const targetLeafHash = hashMerkleLeaf(rawLeaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);
    expect(proof.length).toBe(4);

    const result = executeVerifyProof({
      leaf: targetLeafHash,
      proof,
      root: tree.root,
    });

    expect(result.verified).toBe(true);
    expect(result.status).toBe('SUCCESS');
    expect(result.pathLength).toBe(4);
    expect(result.computedRoot).toBe(tree.root);
  });

  it('verifies authentic 8-hop Merkle proof (256 leaves)', () => {
    // 2^8 = 256 leaves -> 8 hops
    const rawLeaves = Array.from({ length: 256 }, (_, i) =>
      Buffer.from(`audit-ledger-daily-alert-hash-${i}`),
    );
    const tree = buildMerkleTree(rawLeaves);
    expect(tree.layers.length).toBe(9); // 256 -> 128 -> 64 -> 32 -> 16 -> 8 -> 4 -> 2 -> 1 root

    const targetIndex = 147;
    const targetLeafHash = hashMerkleLeaf(rawLeaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);
    expect(proof.length).toBe(8);

    const result = executeVerifyProof({
      leaf: targetLeafHash,
      proof,
      root: tree.root,
    });

    expect(result.verified).toBe(true);
    expect(result.status).toBe('SUCCESS');
    expect(result.pathLength).toBe(8);
    expect(result.computedRoot).toBe(tree.root);
  });

  it('detects tampering when a single bit in the leaf is modified', () => {
    const rawLeaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`alert-item-${i}`),
    );
    const tree = buildMerkleTree(rawLeaves);
    const targetIndex = 3;
    const targetLeafHash = hashMerkleLeaf(rawLeaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    // Tamper with one hex character in leaf
    const tamperedLeaf =
      (targetLeafHash[0] === 'a' ? 'b' : 'a') + targetLeafHash.slice(1);

    const result = executeVerifyProof({
      leaf: tamperedLeaf,
      proof,
      root: tree.root,
    });

    expect(result.verified).toBe(false);
    expect(result.status).toBe('TAMPERED');
    expect(result.computedRoot).not.toBe(tree.root);
  });

  it('detects tampering when a single bit in the proof path is modified', () => {
    const rawLeaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`alert-item-${i}`),
    );
    const tree = buildMerkleTree(rawLeaves);
    const targetIndex = 7;
    const targetLeafHash = hashMerkleLeaf(rawLeaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    // Tamper with siblingHash in step 2
    const tamperedProof = JSON.parse(JSON.stringify(proof));
    const origHash = tamperedProof[2].siblingHash;
    tamperedProof[2].siblingHash =
      (origHash[0] === '0' ? '1' : '0') + origHash.slice(1);

    const result = executeVerifyProof({
      leaf: targetLeafHash,
      proof: tamperedProof,
      root: tree.root,
    });

    expect(result.verified).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });

  it('detects tampering when step direction is inverted', () => {
    const rawLeaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`alert-item-${i}`),
    );
    const tree = buildMerkleTree(rawLeaves);
    const targetIndex = 2;
    const targetLeafHash = hashMerkleLeaf(rawLeaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    // Invert direction of first step
    const tamperedProof = JSON.parse(JSON.stringify(proof));
    tamperedProof[0].direction =
      tamperedProof[0].direction === 'left' ? 'right' : 'left';

    const result = executeVerifyProof({
      leaf: targetLeafHash,
      proof: tamperedProof,
      root: tree.root,
    });

    expect(result.verified).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });

  it('verifies proof from JSON file input (--file)', () => {
    const rawLeaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`certificate-payment-entry-${i}`),
    );
    const tree = buildMerkleTree(rawLeaves);
    const targetIndex = 11;
    const targetLeafHash = hashMerkleLeaf(rawLeaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    const proofFilePath = path.join(tmpDir, 'valid-proof.json');
    fs.writeFileSync(
      proofFilePath,
      JSON.stringify(
        {
          leaf: targetLeafHash,
          proof,
          root: tree.root,
        },
        null,
        2,
      ),
    );

    const result = executeVerifyProof({
      file: proofFilePath,
    });

    expect(result.verified).toBe(true);
    expect(result.status).toBe('SUCCESS');
    expect(result.leaf).toBe(targetLeafHash);
    expect(result.expectedRoot).toBe(tree.root);
  });

  it('detects tampering from JSON file when expected root is modified', () => {
    const rawLeaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`entry-${i}`),
    );
    const tree = buildMerkleTree(rawLeaves);
    const targetIndex = 0;
    const targetLeafHash = hashMerkleLeaf(rawLeaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    const proofFilePath = path.join(tmpDir, 'tampered-root.json');
    fs.writeFileSync(
      proofFilePath,
      JSON.stringify(
        {
          leaf: targetLeafHash,
          proof,
          root: '0'.repeat(64), // tampered root
        },
        null,
        2,
      ),
    );

    const result = executeVerifyProof({
      file: proofFilePath,
    });

    expect(result.verified).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });

  it('accepts comma-separated format for CLI flags', () => {
    const rawLeaves = Array.from({ length: 8 }, (_, i) =>
      Buffer.from(`record-${i}`),
    );
    const tree = buildMerkleTree(rawLeaves);
    const targetIndex = 4;
    const targetLeafHash = hashMerkleLeaf(rawLeaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    const commaFormattedProof = proof
      .map((s) => `${s.direction}:${s.siblingHash}`)
      .join(',');

    const result = executeVerifyProof({
      leaf: targetLeafHash,
      proof: commaFormattedProof,
      root: tree.root,
    });

    expect(result.verified).toBe(true);
    expect(result.status).toBe('SUCCESS');
  });

  it('throws helpful errors when required arguments are missing', () => {
    expect(() =>
      executeVerifyProof({
        leaf: '',
        root: 'a'.repeat(64),
      }),
    ).toThrow(/Missing leaf hash/);

    expect(() =>
      executeVerifyProof({
        leaf: 'a'.repeat(64),
        root: '',
      }),
    ).toThrow(/Missing expected root/);

    expect(() =>
      executeVerifyProof({
        file: path.join(tmpDir, 'non-existent.json'),
      }),
    ).toThrow(/Proof file not found/);
  });
});
