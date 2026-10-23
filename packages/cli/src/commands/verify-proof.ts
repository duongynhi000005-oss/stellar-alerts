import { Command } from 'commander';
import chalk from 'chalk';
import { executeVerifyProof, VerifyProofOptions } from '../lib/merkle-verifier.js';

export function registerVerifyProofCommands(program: Command): void {
  program
    .command('verify-proof')
    .description('Verify cryptographic Merkle inclusion proofs offline with zero external network calls')
    .option('--leaf <hash>', 'Hex-encoded SHA-256 leaf hash')
    .option('--proof <path-hashes>', 'Merkle path sibling hashes (comma-separated, JSON array, or left/right prefixed)')
    .option('--root <root-hash>', 'Expected hex-encoded Merkle root hash')
    .option('-f, --file <path>', 'JSON file containing leaf, proof, and root')
    .option('--json', 'Output result in JSON format')
    .action(async (options: VerifyProofOptions) => {
      try {
        const result = executeVerifyProof(options);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.verified) {
          console.log(chalk.green('SUCCESS: Merkle inclusion proof verified.'));
          console.log(chalk.gray(`Leaf:          ${result.leaf}`));
          console.log(chalk.gray(`Expected Root: ${result.expectedRoot}`));
          console.log(chalk.gray(`Computed Root: ${result.computedRoot}`));
          console.log(chalk.gray(`Path Length:   ${result.pathLength} steps`));
        } else {
          console.error(chalk.red('TAMPERED: Merkle proof verification failed.'));
          console.error(chalk.gray(`Leaf:          ${result.leaf}`));
          console.error(chalk.gray(`Expected Root: ${result.expectedRoot}`));
          console.error(chalk.gray(`Computed Root: ${result.computedRoot ?? '(failed to compute)'}`));
          if (result.error) {
            console.error(chalk.yellow(`Reason:        ${result.error}`));
          }
        }

        if (!result.verified) {
          process.exit(1);
        }
      } catch (err) {
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                verified: false,
                status: 'TAMPERED',
                error: (err as Error).message,
              },
              null,
              2,
            ),
          );
        } else {
          console.error(chalk.red(`TAMPERED: ${(err as Error).message}`));
        }
        process.exit(1);
      }
    });
}
