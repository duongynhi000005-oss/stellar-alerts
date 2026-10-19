#!/usr/bin/env node

/**
 * Lightweight pre-commit secret & private key scanner for Stellar Alerts.
 *
 * Inspects git staged diffs for:
 *  - Stellar secret keys / seeds (`S[A-Z0-9]{55}`)
 *  - Raw private JWT secrets & hardcoded JWT tokens
 *  - PEM private keys
 *  - Common cloud / API credentials (GitHub, AWS, Stripe, Slack, Telegram)
 *  - High-entropy secret assignments (`JWT_SECRET`, `API_KEY`, `PRIVATE_KEY`, etc.)
 *
 * Usage:
 *   node scripts/scan-staged-secrets.mjs [--staged] [--no-verify]
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SECRET_PATTERNS = [
  {
    name: 'Stellar secret key',
    regex: /\bS[A-Z0-9]{55}\b/,
  },
  {
    name: 'PEM private key',
    regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    name: 'Raw JWT token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/,
  },
  {
    name: 'GitHub token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  },
  {
    name: 'AWS access key ID',
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: 'Stripe live key',
    regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/,
  },
  {
    name: 'Slack token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    name: 'Telegram bot token',
    regex: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35,}\b/,
  },
];

const SENSITIVE_KEY_NAME =
  /(?:^|_)(?:JWT_SECRET|NEXTAUTH_SECRET|SESSION_SECRET|PRIVATE_KEY|SECRET_KEY|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_SEED|STELLAR_SECRET)(?:_|$)/;

const QUOTED_DECLARATION =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z][A-Za-z0-9_]*)(?:\s*:\s*string)?\s*=\s*(["'`])([^"'`]+)\2\s*[,;]?\s*$/;
const QUOTED_ASSIGNMENT =
  /^\s*(?:(?:process\.env|this)\.)?["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*[:=]\s*(["'`])([^"'`]+)\2\s*[,;]?\s*$/;
const UNQUOTED_ASSIGNMENT =
  /^\s*([A-Za-z][A-Za-z0-9_]*)\s*[:=]\s*([A-Za-z0-9_+/-]{16,}={0,2})\s*(?:#.*)?$/;

const PLACEHOLDER_VALUE =
  /^(?:your[-_]|example|sample|dummy|test[-_]|ci[-_]|placeholder|changeme|generate[-_]|replace[-_]|mock[-_]|\$|<)/i;

/**
 * Parse a unified git diff and yield only added lines along with their file path
 * and 1-based line number in the new file.
 */
export function* parseAddedDiffLines(diffText) {
  let currentFile = null;
  let lineNumber = 0;
  let inHunk = false;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).trim();
      currentFile = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    if (rawLine.startsWith('Binary files ') || rawLine.startsWith('GIT binary patch')) {
      inHunk = false;
      continue;
    }
    if (rawLine.startsWith('@@ ')) {
      const match = rawLine.match(/\+(\d+)(?:,\d+)?\s@@/);
      inHunk = Boolean(match);
      lineNumber = match ? Number(match[1]) : 0;
      continue;
    }
    if (!inHunk || currentFile === null) {
      continue;
    }

    if (rawLine.startsWith('+')) {
      yield {
        file: currentFile,
        line: lineNumber,
        text: rawLine.slice(1),
      };
      lineNumber += 1;
    } else if (rawLine.startsWith(' ')) {
      lineNumber += 1;
    }
  }
}

/**
 * Check if a single line contains a hardcoded private JWT secret or sensitive API secret assignment.
 */
export function matchSensitiveAssignment(lineText) {
  if (/pragma:\s*allowlist\s+secret/i.test(lineText)) {
    return null;
  }

  const quoted = lineText.match(QUOTED_DECLARATION) || lineText.match(QUOTED_ASSIGNMENT);
  const unquoted = quoted ? null : lineText.match(UNQUOTED_ASSIGNMENT);
  if (!quoted && !unquoted) {
    return null;
  }

  const rawName = (quoted || unquoted)[1];
  const normalizedName = rawName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  if (!SENSITIVE_KEY_NAME.test(normalizedName)) {
    return null;
  }

  const value = quoted ? quoted[3] : unquoted[2];
  if (!value || value.length < 16 || PLACEHOLDER_VALUE.test(value)) {
    return null;
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return null;
  }
  if (new Set(value).size < 8) {
    return null;
  }

  if (normalizedName.includes('JWT') || normalizedName.includes('SESSION') || normalizedName.includes('NEXTAUTH')) {
    return 'Raw private JWT secret';
  }
  return 'Hardcoded API / private secret';
}

/**
 * Check a single line of text for any known secret pattern.
 * Returns the matched pattern name or null if clean.
 */
export function matchSecretLine(lineText) {
  if (/pragma:\s*allowlist\s+secret/i.test(lineText)) {
    return null;
  }

  for (const detector of SECRET_PATTERNS) {
    if (detector.regex.test(lineText)) {
      return detector.name;
    }
  }

  return matchSensitiveAssignment(lineText);
}

/**
 * Scan a unified git diff string and return all secret findings without exposing raw secret values.
 */
export function scanDiffForSecrets(diffText) {
  const findings = [];
  for (const entry of parseAddedDiffLines(diffText)) {
    const kind = matchSecretLine(entry.text);
    if (kind) {
      findings.push({
        kind,
        file: entry.file,
        line: entry.line,
      });
    }
  }
  return findings;
}

/**
 * Build clear remediation instructions when one or more secrets are detected.
 */
export function formatRemediationReport(findings) {
  const lines = [
    '❌ Pre-commit secret scan failed: potential secret(s) detected in staged changes:',
    '',
    ...findings.map(
      (f) => `  • ${f.file.replace(/[\x00-\x1f\x7f]/g, '?')}:${f.line} — ${f.kind}`,
    ),
    '',
    'Remediation instructions:',
    '  1. Unstage the affected file(s): git reset HEAD <file>',
    '  2. Move real secrets or Stellar private seeds (S...) into an untracked .env file',
    '     and reference them via process.env instead of hardcoding.',
    '  3. If a real key was exposed, rotate/revoke it immediately.',
    '  4. For intentional synthetic test fixtures, add `// pragma: allowlist secret`',
    '     or bypass the hook explicitly with: git commit --no-verify',
  ];
  return lines.join('\n');
}

export function readStagedDiff(cwd = process.cwd()) {
  const diffOptions = [
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '--unified=0',
    '--diff-filter=ACMRT',
  ];
  return execFileSync('git', ['diff', ...diffOptions, '--cached', '--', '.'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  if (argv.includes('--no-verify') || process.env.SKIP_SECRET_SCAN === '1') {
    console.log('Secret scan bypassed via --no-verify.');
    return 0;
  }

  let diffText = '';
  try {
    diffText = readStagedDiff(cwd);
  } catch {
    console.error('Unable to read git staged diff for secret scanning.');
    return 2;
  }

  const findings = scanDiffForSecrets(diffText);
  if (findings.length > 0) {
    console.error(formatRemediationReport(findings));
    return 1;
  }

  console.log('Secret scan passed: no Stellar secret keys or private secrets found in staged diff.');
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runCli();
}
