import { Command } from 'commander';
import chalk from 'chalk';
import {
  verifyInclusionProof,
  VerifyProofOptions,
  MerkleVerificationResult,
} from '../lib/merkle-verifier.js';

export function runProofVerification(options: {
  leaf?: string;
  proof?: string;
  root?: string;
  index?: string;
  file?: string;
  json?: boolean;
}): { result: MerkleVerificationResult; exitCode: number } {
  const verifyOptions: VerifyProofOptions = {
    leaf: options.leaf,
    proof: options.proof,
    root: options.root,
    index: options.index !== undefined ? parseInt(options.index, 10) : undefined,
    filePath: options.file,
  };

  const result = verifyInclusionProof(verifyOptions);
  const exitCode = result.success ? 0 : 1;

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return { result, exitCode };
  }

  console.log('');
  console.log(chalk.bold.cyan('🛡️  Offline Merkle Inclusion Proof Verifier'));
  console.log(chalk.gray('═'.repeat(65)));
  console.log(`  Leaf Hash:     ${chalk.yellow(result.leafHash || '(none)')}`);
  console.log(`  Proof Depth:   ${result.proofDepth} step(s)`);
  console.log(`  Expected Root: ${chalk.blue(result.expectedRoot || '(none)')}`);

  if (result.computedRoot) {
    console.log(`  Computed Root: ${result.success ? chalk.green(result.computedRoot) : chalk.red(result.computedRoot)}`);
  }
  console.log(chalk.gray('─'.repeat(65)));

  if (result.status === 'VERIFIED') {
    console.log(chalk.bold.green('  ✅ VERIFIED: Merkle inclusion proof is cryptographically sound.'));
    console.log(chalk.gray('  Leaf is guaranteed to be included in the committed Merkle tree.'));
  } else if (result.status === 'TAMPERED') {
    console.log(chalk.bold.red('  ❌ TAMPERED: Computed Merkle root DOES NOT match expected root!'));
    console.log(chalk.red(`  Reason: ${result.errorMessage || 'Hash mismatch along Merkle path'}`));
  } else {
    console.log(chalk.bold.red(`  ❌ INVALID INPUT: ${result.errorMessage}`));
  }
  console.log(chalk.gray('═'.repeat(65)));
  console.log('');

  return { result, exitCode };
}

export function registerVerifyProofCommands(program: Command): void {
  program
    .command('verify-proof')
    .description('Offline cryptographic Merkle inclusion proof verifier (air-gapped, zero network calls)')
    .option('-l, --leaf <hash>', 'Target leaf hash (64-character hex)')
    .option('-p, --proof <proof>', 'Merkle proof path (JSON array or comma-separated hashes)')
    .option('-r, --root <root>', 'Expected Merkle root hash (64-character hex)')
    .option('-i, --index <number>', '0-based leaf index (required if proof is flat list of sibling hashes)')
    .option('-f, --file <path>', 'JSON proof file containing leaf, proof, and root')
    .option('--json', 'Output result in JSON format')
    .action((options: { leaf?: string; proof?: string; root?: string; index?: string; file?: string; json?: boolean }) => {
      try {
        const { exitCode } = runProofVerification(options);
        if (exitCode !== 0) {
          process.exit(exitCode);
        }
      } catch (err: any) {
        console.error(chalk.red(`❌ Verification failed: ${err.message}`));
        process.exit(1);
      }
    });
}
