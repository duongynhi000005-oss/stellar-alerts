import {
  computeMerkleRoot,
  MerkleProofStep,
  MerkleProofDirection,
} from '@stellar-alerts/shared';
import * as fs from 'fs';

export interface RawMerkleProofStep {
  siblingHash?: string;
  hash?: string;
  direction?: string;
  position?: string;
}

export interface VerifyProofOptions {
  leaf?: string;
  proof?: string | Array<RawMerkleProofStep | string>;
  root?: string;
  file?: string;
  json?: boolean;
}

export interface VerifyProofResult {
  verified: boolean;
  leaf: string;
  expectedRoot: string;
  computedRoot: string | null;
  pathLength: number;
  status: 'SUCCESS' | 'TAMPERED';
  error?: string;
}

export function parseProofStep(item: RawMerkleProofStep | string): MerkleProofStep {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (trimmed.includes(':')) {
      const parts = trimmed.split(':');
      const dirLower = parts[0].toLowerCase();
      const direction: MerkleProofDirection =
        dirLower === 'left' || dirLower === 'l' ? 'left' : 'right';
      return {
        siblingHash: parts[1].trim(),
        direction,
      };
    }
    return {
      siblingHash: trimmed,
      direction: 'right',
    };
  }

  const siblingHash = item.siblingHash || item.hash || '';
  const dirStr = (item.direction || item.position || 'right').toLowerCase();
  const direction: MerkleProofDirection =
    dirStr === 'left' || dirStr === 'l' ? 'left' : 'right';

  return {
    siblingHash: siblingHash.trim(),
    direction,
  };
}

export function parseProofSteps(
  proofInput: string | Array<RawMerkleProofStep | string>,
): MerkleProofStep[] {
  if (Array.isArray(proofInput)) {
    return proofInput.map(parseProofStep);
  }

  const trimmed = proofInput.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map(parseProofStep);
      }
    } catch {
      // fallback to comma-split
    }
  }

  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseProofStep);
}

export function executeVerifyProof(options: VerifyProofOptions): VerifyProofResult {
  let leaf = options.leaf;
  let root = options.root;
  let proofSteps: MerkleProofStep[] = [];

  if (options.file) {
    if (!fs.existsSync(options.file)) {
      throw new Error(`Proof file not found: ${options.file}`);
    }
    const fileContent = fs.readFileSync(options.file, 'utf8');
    const json = JSON.parse(fileContent);

    leaf = leaf || json.leaf || json.leafHash;
    root = root || json.root || json.expectedRoot || json.merkleRoot;

    const rawProof = json.proof || json.path || json.merkleProof;
    if (rawProof) {
      proofSteps = parseProofSteps(rawProof);
    }
  }

  if (options.proof && proofSteps.length === 0) {
    proofSteps = parseProofSteps(options.proof);
  }

  if (!leaf) {
    throw new Error('Missing leaf hash. Specify --leaf <hash> or provide via --file.');
  }
  if (!root) {
    throw new Error('Missing expected root hash. Specify --root <hash> or provide via --file.');
  }

  leaf = leaf.trim();
  root = root.trim();

  let computedRoot: string | null = null;
  let verified = false;

  try {
    computedRoot = computeMerkleRoot(leaf, proofSteps);
    verified = computedRoot.toLowerCase() === root.toLowerCase();
  } catch (err) {
    return {
      verified: false,
      leaf,
      expectedRoot: root,
      computedRoot: null,
      pathLength: proofSteps.length,
      status: 'TAMPERED',
      error: (err as Error).message,
    };
  }

  return {
    verified,
    leaf,
    expectedRoot: root,
    computedRoot,
    pathLength: proofSteps.length,
    status: verified ? 'SUCCESS' : 'TAMPERED',
  };
}
