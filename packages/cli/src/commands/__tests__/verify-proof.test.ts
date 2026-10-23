import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildMerkleTree,
  generateMerkleProof,
  hashMerkleLeaf,
} from '@stellar-alerts/shared';
import {
  verifyInclusionProof,
  normalizeProofSteps,
  loadProofFile,
} from '../../lib/merkle-verifier.js';
import { runProofVerification } from '../verify-proof.js';

describe('Offline Merkle Proof Verifier (#733)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merkle-proof-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('verifies authentic 4-hop Merkle inclusion proof (16 leaves)', () => {
    const leaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`sample_transaction_record_payload_${i}`, 'utf8')
    );
    const tree = buildMerkleTree(leaves);
    const targetIndex = 5;
    const leafHash = hashMerkleLeaf(leaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    expect(proof).toHaveLength(4);

    const result = verifyInclusionProof({
      leaf: leafHash,
      proof,
      root: tree.root,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('VERIFIED');
    expect(result.computedRoot).toBe(tree.root.toLowerCase());
    expect(result.proofDepth).toBe(4);
    expect(result.steps).toHaveLength(4);
  });

  it('verifies authentic 8-hop Merkle inclusion proof (256 leaves)', () => {
    const leaves = Array.from({ length: 256 }, (_, i) =>
      Buffer.from(`high_scale_ledger_payment_${i}_${i * 1337}`, 'utf8')
    );
    const tree = buildMerkleTree(leaves);
    const targetIndex = 137;
    const leafHash = hashMerkleLeaf(leaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    expect(proof).toHaveLength(8);

    const result = verifyInclusionProof({
      leaf: leafHash,
      proof,
      root: tree.root,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('VERIFIED');
    expect(result.computedRoot).toBe(tree.root.toLowerCase());
    expect(result.proofDepth).toBe(8);
  });

  it('detects single-bit tampering in leaf hash (TAMPERED)', () => {
    const leaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`tx_record_${i}`, 'utf8')
    );
    const tree = buildMerkleTree(leaves);
    const targetIndex = 3;
    const originalLeaf = hashMerkleLeaf(leaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    // Flip last character of leaf hash
    const lastChar = originalLeaf.slice(-1);
    const tamperedChar = lastChar === 'a' ? 'b' : 'a';
    const tamperedLeaf = originalLeaf.slice(0, -1) + tamperedChar;

    const result = verifyInclusionProof({
      leaf: tamperedLeaf,
      proof,
      root: tree.root,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('TAMPERED');
    expect(result.computedRoot).not.toBe(tree.root.toLowerCase());
  });

  it('detects single-bit tampering in proof sibling hash (TAMPERED)', () => {
    const leaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`tx_record_${i}`, 'utf8')
    );
    const tree = buildMerkleTree(leaves);
    const targetIndex = 7;
    const leafHash = hashMerkleLeaf(leaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    // Tamper sibling at step 1
    const originalSibling = proof[1].siblingHash;
    const mutatedSibling =
      originalSibling.slice(0, -1) + (originalSibling.slice(-1) === '0' ? '1' : '0');
    proof[1].siblingHash = mutatedSibling;

    const result = verifyInclusionProof({
      leaf: leafHash,
      proof,
      root: tree.root,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('TAMPERED');
    expect(result.computedRoot).not.toBe(tree.root.toLowerCase());
  });

  it('detects mismatched or wrong root hash (TAMPERED)', () => {
    const leaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`tx_record_${i}`, 'utf8')
    );
    const tree = buildMerkleTree(leaves);
    const targetIndex = 2;
    const leafHash = hashMerkleLeaf(leaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    const wrongRoot = '0'.repeat(64);

    const result = verifyInclusionProof({
      leaf: leafHash,
      proof,
      root: wrongRoot,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('TAMPERED');
  });

  it('supports flat array of sibling hashes combined with leaf index', () => {
    const leaves = Array.from({ length: 16 }, (_, i) =>
      Buffer.from(`flat_leaf_${i}`, 'utf8')
    );
    const tree = buildMerkleTree(leaves);
    const targetIndex = 9;
    const leafHash = hashMerkleLeaf(leaves[targetIndex]);
    const structuredProof = generateMerkleProof(tree, targetIndex);

    // Extract flat string array of sibling hashes
    const flatHashes = structuredProof.map((s) => s.siblingHash);

    const result = verifyInclusionProof({
      leaf: leafHash,
      proof: flatHashes,
      index: targetIndex,
      root: tree.root,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('VERIFIED');
    expect(result.computedRoot).toBe(tree.root.toLowerCase());
  });

  it('verifies proof loaded from JSON file', () => {
    const leaves = Array.from({ length: 8 }, (_, i) =>
      Buffer.from(`file_leaf_${i}`, 'utf8')
    );
    const tree = buildMerkleTree(leaves);
    const targetIndex = 4;
    const leafHash = hashMerkleLeaf(leaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    const proofFile = path.join(tempDir, 'proof.json');
    fs.writeFileSync(
      proofFile,
      JSON.stringify(
        {
          leaf: leafHash,
          proof,
          root: tree.root,
        },
        null,
        2
      )
    );

    const result = verifyInclusionProof({ filePath: proofFile });

    expect(result.success).toBe(true);
    expect(result.status).toBe('VERIFIED');
    expect(result.computedRoot).toBe(tree.root.toLowerCase());
  });

  it('rejects invalid hex characters and malformed input (INVALID_INPUT)', () => {
    const invalidLeaf = verifyInclusionProof({
      leaf: 'not_a_valid_64_char_hex',
      proof: ['0'.repeat(64)],
      root: 'a'.repeat(64),
      index: 0,
    });
    expect(invalidLeaf.success).toBe(false);
    expect(invalidLeaf.status).toBe('INVALID_INPUT');

    const invalidRoot = verifyInclusionProof({
      leaf: 'a'.repeat(64),
      proof: ['0'.repeat(64)],
      root: 'invalid_root_string',
      index: 0,
    });
    expect(invalidRoot.success).toBe(false);
    expect(invalidRoot.status).toBe('INVALID_INPUT');
  });

  it('CLI command runner executes and returns correct exit code', () => {
    const leaves = Array.from({ length: 8 }, (_, i) =>
      Buffer.from(`cli_test_${i}`, 'utf8')
    );
    const tree = buildMerkleTree(leaves);
    const targetIndex = 1;
    const leafHash = hashMerkleLeaf(leaves[targetIndex]);
    const proof = generateMerkleProof(tree, targetIndex);

    // 1. Valid proof -> exitCode 0
    const validRun = runProofVerification({
      leaf: leafHash,
      proof: JSON.stringify(proof),
      root: tree.root,
      json: true,
    });
    expect(validRun.exitCode).toBe(0);
    expect(validRun.result.success).toBe(true);

    // 2. Tampered root -> exitCode 1
    const tamperedRun = runProofVerification({
      leaf: leafHash,
      proof: JSON.stringify(proof),
      root: 'f'.repeat(64),
      json: true,
    });
    expect(tamperedRun.exitCode).toBe(1);
    expect(tamperedRun.result.success).toBe(false);
  });
});
