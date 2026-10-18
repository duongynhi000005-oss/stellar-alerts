import { describe, it, expect, vi } from 'vitest';
import {
  generateAccessToken,
  generateMagicToken,
  generateRefreshToken,
  generateSessionToken,
  verifyRefreshToken,
  verifyToken,
  MagicLinkPayload,
  UserPayload,
} from '../jwt';

// Mock env for isolated test execution
vi.mock('../../config/env', () => ({
  env: {
    JWT_SECRET: 'test-super-secret-jwt-key-12345',
  },
}));

describe('JWT Utilities', () => {
  it('should generate and verify a valid magic link token', () => {
    const email = 'reviewer@drips.network';
    const token = generateMagicToken(email);

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(10);

    const decoded = verifyToken<MagicLinkPayload>(token);
    expect(decoded.email).toBe(email);
    expect(typeof decoded.jti).toBe('string');
  });

  it('should generate and verify a valid session token with a unique jti', () => {
    const userPayload: UserPayload = {
      id: 'cuid_test_user_123',
      email: 'user@stellar-alerts.org',
    };

    const token = generateSessionToken(userPayload);
    expect(typeof token).toBe('string');

    const decoded = verifyToken<UserPayload>(token);
    expect(decoded.id).toBe(userPayload.id);
    expect(decoded.email).toBe(userPayload.email);
    // Every session token must carry a unique jti for revocation support.
    expect(typeof decoded.jti).toBe('string');
    expect(decoded.jti!.length).toBeGreaterThan(0);

    // Two tokens for the same user must have distinct jtis.
    const token2 = generateSessionToken(userPayload);
    const decoded2 = verifyToken<UserPayload>(token2);
    expect(decoded.jti).not.toBe(decoded2.jti);
  });

  it('should bind familyId on access tokens when provided', () => {
    const token = generateAccessToken({
      id: 'user_99',
      email: 'ops@stellar-alerts.org',
      familyId: 'fam_abc',
    });
    const decoded = verifyToken<UserPayload>(token);
    expect(decoded.id).toBe('user_99');
    expect(decoded.familyId).toBe('fam_abc');
  });

  it('should generate and verify rotating refresh tokens via verifyRefreshToken', () => {
    const { token, jti } = generateRefreshToken({
      userId: 'user_99',
      familyId: 'fam_abc',
      rotationCounter: 2,
    });

    const decoded = verifyRefreshToken(token);
    expect(decoded.userId).toBe('user_99');
    expect(decoded.familyId).toBe('fam_abc');
    expect(decoded.rotationCounter).toBe(2);
    expect(decoded.jti).toBe(jti);
    expect(decoded.tokenType).toBe('refresh');
  });

  it('should reject non-refresh tokens passed to verifyRefreshToken', () => {
    const magic = generateMagicToken('test@stellar-alerts.org');
    expect(() => verifyRefreshToken(magic)).toThrow('Invalid refresh token payload');
  });

  it('should throw error when verifying an invalid token', () => {
    expect(() => verifyToken('invalid-malformed-token-string')).toThrow();
  });
});
