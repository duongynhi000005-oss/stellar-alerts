import * as fs from 'fs';
import {
  hashMerkleNode,
  MerkleProofStep,
  MerkleProofDirection,
} from '@stellar-alerts/shared';

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

export interface ProofFilePayload {
  leaf: string;
  proof: MerkleProofStep[] | string[];
  root: string;
  index?: number;
}

export interface VerifyProofOptions {
  leaf?: string;
  proof?: string | MerkleProofStep[] | string[];
  root?: string;
  index?: number;
  filePath?: string;
}

export interface VerificationStepTrace {
  level: number;
  direction: MerkleProofDirection;
  siblingHash: string;
  parentHash: string;
}

export interface MerkleVerificationResult {
  success: boolean;
  status: 'VERIFIED' | 'TAMPERED' | 'INVALID_INPUT';
  computedRoot: string;
  expectedRoot: string;
  leafHash: string;
  proofDepth: number;
  steps: VerificationStepTrace[];
  errorMessage?: string;
}

export function isValidHex64(val: unknown): val is string {
  return typeof val === 'string' && HEX_64_REGEX.test(val);
}

/**
 * Normalizes proof steps from either an array of MerkleProofStep objects
 * or an array/string of sibling hashes combined with a leaf index.
 */
export function normalizeProofSteps(
  rawProof: unknown,
  leafIndex?: number
): MerkleProofStep[] {
  let steps: unknown[] = [];

  if (typeof rawProof === 'string') {
    const trimmed = rawProof.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        steps = JSON.parse(trimmed);
      } catch (err: any) {
        throw new Error(`Failed to parse proof JSON string: ${err.message}`);
      }
    } else {
      // Comma-separated or space-separated list of 64-char hashes
      steps = trimmed.split(/[\s,]+/).filter(Boolean);
    }
  } else if (Array.isArray(rawProof)) {
    steps = rawProof;
  } else {
    throw new Error('Proof must be an array or string of sibling steps');
  }

  if (steps.length === 0) {
    throw new Error('Proof path cannot be empty');
  }

  // Case 1: Structured MerkleProofStep[] objects
  if (typeof steps[0] === 'object' && steps[0] !== null && 'siblingHash' in steps[0]) {
    return steps.map((s: any, idx: number) => {
      if (!isValidHex64(s.siblingHash)) {
        throw new Error(`Invalid sibling hash at step ${idx}: "${s.siblingHash}"`);
      }
      const dir = (s.direction || '').toLowerCase();
      if (dir !== 'left' && dir !== 'right') {
        throw new Error(`Invalid direction at step ${idx}: expected "left" or "right", got "${s.direction}"`);
      }
      return {
        siblingHash: s.siblingHash.toLowerCase(),
        direction: dir as MerkleProofDirection,
      };
    });
  }

  // Case 2: Array of hex strings + leafIndex to derive left/right directions
  if (leafIndex === undefined || leafIndex < 0) {
    throw new Error('leafIndex (0-based) is required when proof is a flat array of sibling hashes');
  }

  let currentIndex = leafIndex;
  const result: MerkleProofStep[] = [];

  for (let i = 0; i < steps.length; i++) {
    const siblingHash = String(steps[i]).trim().toLowerCase();
    if (!isValidHex64(siblingHash)) {
      throw new Error(`Invalid sibling hash at index ${i}: "${siblingHash}"`);
    }

    const isRightNode = currentIndex % 2 === 1;
    const direction: MerkleProofDirection = isRightNode ? 'left' : 'right';

    result.push({ siblingHash, direction });
    currentIndex = Math.floor(currentIndex / 2);
  }

  return result;
}

/**
 * Loads and parses a proof file from local disk.
 */
export function loadProofFile(filePath: string): ProofFilePayload {
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Proof file must contain a valid JSON object');
  }

  return {
    leaf: parsed.leaf || parsed.leafHash,
    proof: parsed.proof || parsed.path || parsed.merkleProof,
    root: parsed.root || parsed.merkleRoot || parsed.expectedRoot,
    index: parsed.index !== undefined ? parsed.index : parsed.leafIndex,
  };
}

/**
 * Executes offline cryptographic Merkle inclusion proof verification.
 * Pure in-memory computation with zero network access.
 */
export function verifyInclusionProof(options: VerifyProofOptions): MerkleVerificationResult {
  let leaf = options.leaf;
  let proof = options.proof;
  let root = options.root;
  let index = options.index;

  // Load from file if provided
  if (options.filePath) {
    try {
      const fileData = loadProofFile(options.filePath);
      leaf = leaf || fileData.leaf;
      proof = proof || fileData.proof;
      root = root || fileData.root;
      if (index === undefined) index = fileData.index;
    } catch (err: any) {
      return {
        success: false,
        status: 'INVALID_INPUT',
        computedRoot: '',
        expectedRoot: root || '',
        leafHash: leaf || '',
        proofDepth: 0,
        steps: [],
        errorMessage: `Failed to load proof file: ${err.message}`,
      };
    }
  }

  if (!isValidHex64(leaf)) {
    return {
      success: false,
      status: 'INVALID_INPUT',
      computedRoot: '',
      expectedRoot: root || '',
      leafHash: leaf || '',
      proofDepth: 0,
      steps: [],
      errorMessage: `Invalid leaf hash: expected 64-character hex string, got "${leaf}"`,
    };
  }

  if (!isValidHex64(root)) {
    return {
      success: false,
      status: 'INVALID_INPUT',
      computedRoot: '',
      expectedRoot: root || '',
      leafHash: leaf,
      proofDepth: 0,
      steps: [],
      errorMessage: `Invalid expected root: expected 64-character hex string, got "${root}"`,
    };
  }

  let steps: MerkleProofStep[];
  try {
    steps = normalizeProofSteps(proof, index);
  } catch (err: any) {
    return {
      success: false,
      status: 'INVALID_INPUT',
      computedRoot: '',
      expectedRoot: root.toLowerCase(),
      leafHash: leaf.toLowerCase(),
      proofDepth: 0,
      steps: [],
      errorMessage: err.message,
    };
  }

  let currentBuffer = Buffer.from(leaf, 'hex');
  const trace: VerificationStepTrace[] = [];

  for (let level = 0; level < steps.length; level++) {
    const step = steps[level];
    const siblingBuffer = Buffer.from(step.siblingHash, 'hex');

    const parentHex =
      step.direction === 'left'
        ? hashMerkleNode(siblingBuffer, currentBuffer)
        : hashMerkleNode(currentBuffer, siblingBuffer);

    trace.push({
      level: level + 1,
      direction: step.direction,
      siblingHash: step.siblingHash,
      parentHash: parentHex,
    });

    currentBuffer = Buffer.from(parentHex, 'hex');
  }

  const computedRoot = currentBuffer.toString('hex').toLowerCase();
  const expectedRoot = root.toLowerCase();
  const isMatch = computedRoot === expectedRoot;

  return {
    success: isMatch,
    status: isMatch ? 'VERIFIED' : 'TAMPERED',
    computedRoot,
    expectedRoot,
    leafHash: leaf.toLowerCase(),
    proofDepth: steps.length,
    steps: trace,
    errorMessage: isMatch ? undefined : `Computed root does not match expected root`,
  };
}
