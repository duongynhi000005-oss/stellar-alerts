import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  matchSecretLine,
  scanDiffForSecrets,
  formatRemediationReport,
  runCli,
} from './scan-staged-secrets.mjs';

function buildPatch(file: string, addedLines: string[], removedLines: string[] = []): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removedLines.length} +1,${addedLines.length} @@`,
    ...removedLines.map((l) => `-${l}`),
    ...addedLines.map((l) => `+${l}`),
  ].join('\n');
}

describe('scan-staged-secrets pattern matcher', () => {
  it('detects valid 56-character Stellar secret keys (S[A-Z0-9]{55})', () => {
    const stellarSecret = 'S' + 'B7K2M9Q4X8W1N5P3R6T0V2Y4Z7C9D1F3G5H7J9L2N4P6R8T0V2X4Z6A';
    expect(stellarSecret).toHaveLength(56);
    expect(matchSecretLine(`STELLAR_SECRET_KEY=${stellarSecret}`)).toBe('Stellar secret key');
    expect(matchSecretLine(`const seed = "${stellarSecret}";`)).toBe('Stellar secret key');
  });

  it('does not flag valid Stellar public keys (G...) or contract IDs (C...)', () => {
    const publicKey = 'G' + 'A'.repeat(55);
    const contractId = 'C' + 'B'.repeat(55);
    const shortS = 'S' + 'A'.repeat(54);
    const longS = 'S' + 'A'.repeat(56);

    expect(matchSecretLine(`const wallet = "${publicKey}";`)).toBeNull();
    expect(matchSecretLine(`const contract = "${contractId}";`)).toBeNull();
    expect(matchSecretLine(`const tooShort = "${shortS}";`)).toBeNull();
    expect(matchSecretLine(`const tooLong = "${longS}";`)).toBeNull();
  });

  it('detects raw private JWT secrets and hardcoded JWT tokens', () => {
    const rawJwtSecret = 'k9P2mX7vQ4nL8rT1wY6zB3cF5hJ0sD2g';
    expect(matchSecretLine(`JWT_SECRET="${rawJwtSecret}"`)).toBe('Raw private JWT secret');
    expect(matchSecretLine(`const jwtSecret = '${rawJwtSecret}';`)).toBe(
      'Raw private JWT secret',
    );

    const jwtToken =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlN0ZWxsYXIifQ.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(matchSecretLine(`Authorization: Bearer ${jwtToken}`)).toBe('Raw JWT token');
  });

  it('ignores placeholder JWT secrets and environment variable references', () => {
    expect(matchSecretLine('JWT_SECRET=your-super-secret-jwt-key')).toBeNull();
    expect(matchSecretLine('JWT_SECRET=test-jwt-secret-key-123456')).toBeNull();
    expect(matchSecretLine('const jwtSecret = process.env.JWT_SECRET;')).toBeNull();
  });

  it('respects inline allowlist comments and --no-verify bypass flag', () => {
    const stellarSecret = 'S' + 'A'.repeat(55);
    expect(
      matchSecretLine(`const fixtureSeed = "${stellarSecret}"; // pragma: allowlist secret`),
    ).toBeNull();

    expect(runCli(['--no-verify'])).toBe(0);
  });

  it('scans unified diffs, ignores removed lines, and formats remediation instructions without leaking secrets', () => {
    const stellarSecret = 'S' + '9'.repeat(55);
    const patch = buildPatch(
      'apps/api/.env',
      ['PORT=3001', `STELLAR_SIGNER=${stellarSecret}`],
      [`OLD_SECRET=${stellarSecret}`],
    );

    const findings = scanDiffForSecrets(patch);
    expect(findings).toEqual([
      {
        kind: 'Stellar secret key',
        file: 'apps/api/.env',
        line: 2,
      },
    ]);

    const report = formatRemediationReport(findings);
    expect(report).toContain('apps/api/.env:2 — Stellar secret key');
    expect(report).toContain('git reset HEAD <file>');
    expect(report).toContain('--no-verify');
    expect(report).not.toContain(stellarSecret);
  });

  it('executes in under 200ms on a realistic multi-file code commit diff', () => {
    const normalLines = Array.from(
      { length: 250 },
      (_, idx) => `export const metricValue_${idx} = ${idx * 42};`,
    );
    const patch = buildPatch('packages/cli/src/index.ts', normalLines);

    const start = performance.now();
    const findings = scanDiffForSecrets(patch);
    const elapsedMs = performance.now() - start;

    expect(findings).toEqual([]);
    expect(elapsedMs).toBeLessThan(200);
  });
});
