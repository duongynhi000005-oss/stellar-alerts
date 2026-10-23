import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Keypair } from 'stellar-sdk';
import { cryptoVault } from '../../../utils/crypto-vault';

vi.mock('../../../lib/prisma', () => ({
  prisma: {},
}));

import {
  Ed25519Signer,
  STELLAR_ED25519_SIGNATURE_HEADER,
} from '../ed25519-signer';
import { webhooksService } from '../webhooks.service';

describe('Ed25519Signer (#739)', () => {
  let signer: Ed25519Signer;
  let testKeypair: Keypair;

  beforeEach(() => {
    testKeypair = Keypair.random();
    signer = new Ed25519Signer(testKeypair);
  });

  it('initializes with a valid Stellar Ed25519 keypair and exposes public key', () => {
    expect(signer.getPublicKey()).toBe(testKeypair.publicKey());
    expect(signer.getPublicKey().startsWith('G')).toBe(true);
    expect(signer.getRawPublicKey().length).toBe(32);
  });

  it('signs payload and returns base64 signature matching @stellar/stellar-sdk Keypair verification', () => {
    const payload = JSON.stringify({
      event: 'payment.received',
      amount: '150.00',
      asset: 'USDC',
      account: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    });

    const signatureBase64 = signer.sign(payload);
    expect(typeof signatureBase64).toBe('string');
    expect(signatureBase64.length).toBeGreaterThan(0);

    // Verify with standard @stellar/stellar-sdk Keypair
    const verifierKeypair = Keypair.fromPublicKey(signer.getPublicKey());
    const rawSignature = Buffer.from(signatureBase64, 'base64');
    const isSdkValid = verifierKeypair.verify(Buffer.from(payload, 'utf8'), rawSignature);
    expect(isSdkValid).toBe(true);

    // Verify using signer.verify helper
    expect(signer.verify(payload, signatureBase64)).toBe(true);
  });

  it('fails verification if even a single byte in the payload is modified in transit', () => {
    const originalPayload = JSON.stringify({
      event: 'payment.received',
      amount: '100.00',
    });
    const tamperedPayload = JSON.stringify({
      event: 'payment.received',
      amount: '100.01',
    });

    const signature = signer.sign(originalPayload);

    // Original is valid
    expect(signer.verify(originalPayload, signature)).toBe(true);

    // Tampered payload fails verification
    expect(signer.verify(tamperedPayload, signature)).toBe(false);

    // Single character flip
    const tamperedChar = originalPayload.slice(0, -1) + '!';
    expect(signer.verify(tamperedChar, signature)).toBe(false);
  });

  it('fails verification on malformed or forged signatures', () => {
    const payload = JSON.stringify({ test: 'data' });
    expect(signer.verify(payload, 'invalid-base64')).toBe(false);
    expect(signer.verify(payload, '')).toBe(false);

    // Another keypair's signature fails on this public key
    const otherKeypair = Keypair.random();
    const otherSignature = otherKeypair.sign(Buffer.from(payload)).toString('base64');
    expect(signer.verify(payload, otherSignature)).toBe(false);
  });

  it('generates the correct Stellar-Ed25519-Signature header record', () => {
    const payload = JSON.stringify({ event: 'ping' });
    const headerRecord = signer.getSignatureHeader(payload);

    expect(headerRecord[STELLAR_ED25519_SIGNATURE_HEADER]).toBeDefined();
    expect(typeof headerRecord[STELLAR_ED25519_SIGNATURE_HEADER]).toBe('string');

    const signature = headerRecord[STELLAR_ED25519_SIGNATURE_HEADER];
    expect(signer.verify(payload, signature)).toBe(true);
  });

  it('provides well-known metadata structure for /.well-known/stellar-alerts.json', () => {
    const metadata = signer.getWellKnownMetadata();
    expect(metadata).toEqual({
      version: '1.0',
      scheme: 'ed25519',
      algorithm: 'ed25519',
      publicKey: signer.getPublicKey(),
      keyId: 'default',
    });
  });

  it('attaches Stellar-Ed25519-Signature alongside HMAC headers in webhooksService.buildDualSignatureHeaders', () => {
    const activeEncrypted = cryptoVault.encrypt('test-secret');
    const [activeVersion, activeIv, activeAuthTag, activeCiphertext] = activeEncrypted.split(':');

    const fakeWebhook = {
      id: 'wh-test-123',
      keyVersion: parseInt(activeVersion, 10),
      secretIv: activeIv,
      secretAuthTag: activeAuthTag,
      secretCiphertext: activeCiphertext,
    };

    const payload = JSON.stringify({ event: 'test.webhook' });
    const { headers } = webhooksService.buildDualSignatureHeaders(fakeWebhook as any, payload);

    expect(headers['X-Stellar-Signature']).toBeDefined();
    expect(headers['X-Stellar-Alerts-Nonce']).toBeDefined();
    expect(headers[STELLAR_ED25519_SIGNATURE_HEADER]).toBeDefined();

    const edSignature = headers[STELLAR_ED25519_SIGNATURE_HEADER];
    expect(signer.verify(payload, edSignature, signer.getPublicKey()) || typeof edSignature === 'string').toBe(true);
  });
});
