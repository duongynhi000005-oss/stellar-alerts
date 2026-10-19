import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  STELLAR_SIGNATURE_HEADER,
  createSignatureChallenge,
  generateStellarTestKeypair,
  signChallengeWithSecretKey,
  verifyStellarSignature,
  requestWalletSignature,
  submitSignedMutation,
  parseSignatureHeader,
  SignatureGuardError,
} from './signature-guard';
import { isValidEd25519PublicKey } from '@stellar-alerts/shared';

describe('signature-guard (#648)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (typeof window !== 'undefined') {
      delete (window as unknown as Record<string, unknown>).freighterApi;
      delete (window as unknown as Record<string, unknown>).albedo;
    }
  });

  it('generates a valid Stellar Ed25519 test keypair and cryptographically verifies signatures', async () => {
    const keypair = await generateStellarTestKeypair();
    expect(isValidEd25519PublicKey(keypair.publicKey)).toBe(true);
    expect(keypair.secretKey).toMatch(/^S[A-Z2-7]{55}$/);

    const challengeObj = createSignatureChallenge({
      action: 'RULE_MUTATION',
      payload: { logic: 'AND', conditions: [{ field: 'amount', operator: 'gt', value: '500' }] },
      publicKey: keypair.publicKey,
      timestamp: 1710000000000,
    });

    const signature = await signChallengeWithSecretKey(challengeObj.challenge, keypair.secretKey);
    expect(signature).toBeTruthy();

    const isValid = await verifyStellarSignature({
      publicKey: keypair.publicKey,
      challenge: challengeObj.challenge,
      signature,
      now: 1710000005000,
    });
    expect(isValid).toBe(true);

    // Tampered challenge must fail verification
    const tamperedValid = await verifyStellarSignature({
      publicKey: keypair.publicKey,
      challenge: challengeObj.challenge.replace('500', '999999'),
      signature,
      now: 1710000005000,
    });
    expect(tamperedValid).toBe(false);

    // Expired timestamp must fail verification
    const expiredValid = await verifyStellarSignature({
      publicKey: keypair.publicKey,
      challenge: challengeObj.challenge,
      signature,
      now: 1710000000000 + 10 * 60 * 1000,
    });
    expect(expiredValid).toBe(false);
  });

  it('signs a challenge via Freighter and attaches X-Stellar-Signature on mutation submission', async () => {
    const keypair = await generateStellarTestKeypair();

    (window as unknown as Record<string, unknown>).freighterApi = {
      signMessage: vi.fn(async (msg: string) => keypair.sign(msg)),
    };

    const payload = {
      logic: 'AND',
      conditions: [{ field: 'asset', operator: 'eq', value: 'USDC' }],
    };

    const proof = await requestWalletSignature({
      action: 'RULE_MUTATION',
      payload,
      publicKey: keypair.publicKey,
      provider: 'freighter',
      verifyCryptographically: true,
    });

    expect(proof.publicKey).toBe(keypair.publicKey);
    expect(proof.headerValue).toContain(`pub=${keypair.publicKey}`);

    const parsedHeader = parseSignatureHeader(proof.headerValue);
    expect(parsedHeader.publicKey).toBe(keypair.publicKey);
    expect(parsedHeader.signature).toBe(proof.signature);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, ruleId: 'rule-123' }),
    });

    const response = await submitSignedMutation<{ success: boolean; ruleId: string }>({
      endpoint: 'http://localhost:3001/rules',
      method: 'POST',
      payload,
      proof,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(response).toEqual({ success: true, ruleId: 'rule-123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers[STELLAR_SIGNATURE_HEADER]).toBe(proof.headerValue);
  });

  it('supports Albedo wallet signing and surfaces user rejection errors cleanly', async () => {
    const keypair = await generateStellarTestKeypair();

    (window as unknown as Record<string, unknown>).albedo = {
      signMessage: vi.fn().mockRejectedValue(new Error('User rejected the signature request')),
    };

    await expect(
      requestWalletSignature({
        action: 'WEBHOOK_MUTATION',
        payload: { webhookUrl: 'https://hooks.example.com/stellar' },
        publicKey: keypair.publicKey,
        provider: 'albedo',
      })
    ).rejects.toMatchObject({
      name: 'SignatureGuardError',
      code: 'USER_REJECTED',
    } satisfies Partial<SignatureGuardError>);
  });
});
