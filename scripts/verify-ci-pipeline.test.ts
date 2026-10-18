import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..');

describe('GitHub Actions Automated Build, Typecheck & Test Pipeline (#546)', () => {
  it('passes the CI workspace matrix and pipeline contract verifier', () => {
    const output = execFileSync(
      process.execPath,
      [join(repoRoot, '.github', 'verify-workspace-matrix.mjs')],
      { encoding: 'utf8' },
    );
    expect(output).toContain('CI workspace matrix contract OK:');
    expect(output).toContain('apps/api');
    expect(output).toContain('apps/web');
    expect(output).toContain('packages/shared');
  });

  it('triggers on push and pull_request and runs Prisma, Typecheck, Vitest, and Next.js build', () => {
    const ciYaml = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ciYaml).toContain('push:');
    expect(ciYaml).toContain('pull_request:');
    expect(ciYaml).toContain('npx prisma generate');
    expect(ciYaml).toContain('packages/shared');
    expect(ciYaml).toContain('npm run test:unit --workspace=api');
    expect(ciYaml).toContain('npm run build --workspace=web');
  });
});
