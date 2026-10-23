import { Keypair } from 'stellar-sdk';

export const STELLAR_ED25519_SIGNATURE_HEADER = 'Stellar-Ed25519-Signature';

export interface Ed25519WellKnownMetadata {
  version: string;
  scheme: string;
  algorithm: string;
  publicKey: string;
  keyId: string;
}

export class Ed25519Signer {
  private keypair: Keypair;
  private keyId: string;

  constructor(secretKeyOrKeypair?: string | Keypair, keyId: string = 'default') {
    this.keyId = keyId;
    if (secretKeyOrKeypair instanceof Keypair) {
      this.keypair = secretKeyOrKeypair;
    } else if (typeof secretKeyOrKeypair === 'string' && secretKeyOrKeypair.trim().length > 0) {
      this.keypair = Keypair.fromSecret(secretKeyOrKeypair.trim());
    } else if (process.env.WEBHOOK_ED25519_SECRET_KEY && process.env.WEBHOOK_ED25519_SECRET_KEY.trim().length > 0) {
      this.keypair = Keypair.fromSecret(process.env.WEBHOOK_ED25519_SECRET_KEY.trim());
    } else {
      this.keypair = Keypair.random();
    }
  }

  /**
   * Returns the Stellar G... encoded public key.
   */
  public getPublicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Returns the raw 32-byte Ed25519 public key buffer.
   */
  public getRawPublicKey(): Buffer {
    return this.keypair.rawPublicKey();
  }

  /**
   * Returns the key identifier.
   */
  public getKeyId(): string {
    return this.keyId;
  }

  /**
   * Sets or overrides the active keypair (useful for testing and key rotation).
   */
  public setKeypair(keypair: Keypair, keyId: string = 'default'): void {
    this.keypair = keypair;
    this.keyId = keyId;
  }

  /**
   * Signs outgoing JSON payload bytes using server Ed25519 keypair and returns base64 string.
   */
  public sign(payload: string | Buffer): string {
    const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    const signature = this.keypair.sign(data);
    return signature.toString('base64');
  }

  /**
   * Verifies an incoming or transmitted signature against payload bytes.
   * If publicKey is not provided, uses the server's own public key.
   */
  public verify(payload: string | Buffer, signatureBase64: string, publicKey?: string): boolean {
    try {
      if (!signatureBase64 || typeof signatureBase64 !== 'string') {
        return false;
      }
      const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
      const signature = Buffer.from(signatureBase64, 'base64');
      const verifier = publicKey ? Keypair.fromPublicKey(publicKey) : this.keypair;
      return verifier.verify(data, signature);
    } catch {
      return false;
    }
  }

  /**
   * Helper that builds the header record with Stellar-Ed25519-Signature.
   */
  public getSignatureHeader(payload: string | Buffer): Record<string, string> {
    return {
      [STELLAR_ED25519_SIGNATURE_HEADER]: this.sign(payload),
    };
  }

  /**
   * Metadata payload published on GET /.well-known/stellar-alerts.json
   */
  public getWellKnownMetadata(): Ed25519WellKnownMetadata {
    return {
      version: '1.0',
      scheme: 'ed25519',
      algorithm: 'ed25519',
      publicKey: this.getPublicKey(),
      keyId: this.keyId,
    };
  }
}

export const ed25519Signer = new Ed25519Signer();
