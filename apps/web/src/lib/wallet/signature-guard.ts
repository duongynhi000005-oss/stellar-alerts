import { isValidEd25519PublicKey } from '@stellar-alerts/shared';

export const STELLAR_SIGNATURE_HEADER = 'X-Stellar-Signature';
export const STELLAR_PUBLIC_KEY_HEADER = 'X-Stellar-Public-Key';
export const STELLAR_CHALLENGE_HEADER = 'X-Stellar-Challenge';
export const STELLAR_TIMESTAMP_HEADER = 'X-Stellar-Timestamp';

export const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type WalletProviderType = 'freighter' | 'albedo' | 'custom';

export type MutationActionType =
  | 'RULE_MUTATION'
  | 'WEBHOOK_MUTATION'
  | 'SENSITIVE_SETTINGS_MUTATION';

export type SignatureGuardErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'USER_REJECTED'
  | 'INVALID_PUBLIC_KEY'
  | 'SIGNATURE_INVALID'
  | 'CHALLENGE_EXPIRED'
  | 'MUTATION_FAILED';

export class SignatureGuardError extends Error {
  readonly code: SignatureGuardErrorCode;

  constructor(code: SignatureGuardErrorCode, message: string) {
    super(message);
    this.name = 'SignatureGuardError';
    this.code = code;
    Object.setPrototypeOf(this, SignatureGuardError.prototype);
  }
}

export interface SignatureChallenge {
  challenge: string;
  action: string;
  publicKey: string;
  timestamp: number;
  nonce: string;
  payloadDigest: string;
}

export interface SignedMutationProof {
  publicKey: string;
  signature: string;
  challenge: string;
  timestamp: number;
  action: string;
  provider: WalletProviderType;
  headerValue: string;
}

export type WalletSignerFn = (
  challenge: string,
  context: { publicKey: string; provider: WalletProviderType; action: string }
) => Promise<string | { signature: string; publicKey?: string }>;

export interface RequestWalletSignatureOptions {
  action: MutationActionType | string;
  payload: unknown;
  publicKey: string;
  provider?: WalletProviderType;
  timestamp?: number;
  nonce?: string;
  challengeOverride?: SignatureChallenge;
  signer?: WalletSignerFn;
  verifyCryptographically?: boolean;
}

export interface SubmitSignedMutationOptions {
  endpoint: string;
  method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payload: unknown;
  proof: SignedMutationProof;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export interface StellarTestKeypair {
  publicKey: string;
  secretKey: string;
  rawPublicKey: Uint8Array;
  rawSecretSeed: Uint8Array;
  sign: (message: string | Uint8Array) => Promise<string>;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VERSION_BYTE_ACCOUNT_ID = 6 << 3; // 48 ('G...')
const VERSION_BYTE_SECRET_SEED = 18 << 3; // 144 ('S...')

// RFC 8410 ASN.1 DER prefixes for Ed25519 keys in WebCrypto:
// SubjectPublicKeyInfo (SPKI) prefix (12 bytes) + 32-byte raw public key = 44 bytes
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

// PKCS#8 PrivateKeyInfo prefix (16 bytes) + 32-byte raw seed = 48 bytes
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = '';

  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >>> bits) & 0x1f];
    }
    buffer &= (1 << bits) - 1;
  }

  if (bits > 0) {
    out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}

function base32Decode(input: string): Uint8Array | null {
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];

  for (let i = 0; i < input.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(input[i]);
    if (idx === -1) return null;
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }

  if (bits > 0 && buffer !== 0) return null;
  return Uint8Array.from(bytes);
}

function encodeStrKey(versionByte: number, payload: Uint8Array): string {
  const body = new Uint8Array(payload.length + 1);
  body[0] = versionByte;
  body.set(payload, 1);

  const checksum = crc16Xmodem(body);
  const full = new Uint8Array(body.length + 2);
  full.set(body, 0);
  full[body.length] = checksum & 0xff;
  full[body.length + 1] = (checksum >> 8) & 0xff;

  return base32Encode(full);
}

function decodeStrKeyPayload(encoded: string, expectedVersionByte: number): Uint8Array {
  if (typeof encoded !== 'string' || encoded.length !== 56) {
    throw new SignatureGuardError('INVALID_PUBLIC_KEY', 'Invalid Stellar StrKey length.');
  }
  const decoded = base32Decode(encoded);
  if (!decoded || decoded.length !== 35 || decoded[0] !== expectedVersionByte) {
    throw new SignatureGuardError('INVALID_PUBLIC_KEY', 'Invalid Stellar StrKey encoding or version byte.');
  }
  const body = decoded.subarray(0, 33);
  const expectedChecksum = decoded[33] | (decoded[34] << 8);
  if (crc16Xmodem(body) !== expectedChecksum) {
    throw new SignatureGuardError('INVALID_PUBLIC_KEY', 'Invalid Stellar StrKey CRC16 checksum.');
  }
  return decoded.subarray(1, 33);
}

/** Decodes a 56-character Stellar `G...` address into its raw 32-byte Ed25519 public key. */
export function decodeStellarPublicKey(publicKey: string): Uint8Array {
  return decodeStrKeyPayload(publicKey.trim(), VERSION_BYTE_ACCOUNT_ID);
}

/** Encodes a raw 32-byte Ed25519 public key into a 56-character Stellar `G...` address. */
export function encodeStellarPublicKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) {
    throw new SignatureGuardError('INVALID_PUBLIC_KEY', 'Ed25519 public key must be 32 bytes.');
  }
  return encodeStrKey(VERSION_BYTE_ACCOUNT_ID, rawPublicKey);
}

/** Decodes a 56-character Stellar `S...` secret seed into its raw 32-byte Ed25519 private seed. */
export function decodeStellarSecretSeed(secretKey: string): Uint8Array {
  return decodeStrKeyPayload(secretKey.trim(), VERSION_BYTE_SECRET_SEED);
}

/** Encodes a raw 32-byte Ed25519 private seed into a 56-character Stellar `S...` secret key. */
export function encodeStellarSecretSeed(rawSeed: Uint8Array): string {
  if (rawSeed.length !== 32) {
    throw new SignatureGuardError('INVALID_PUBLIC_KEY', 'Ed25519 secret seed must be 32 bytes.');
  }
  return encodeStrKey(VERSION_BYTE_SECRET_SEED, rawSeed);
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array {
  const normalized = encoded.trim();
  if (/^[0-9a-fA-F]{128}$/.test(normalized)) {
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      out[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(normalized, 'base64'));
  }
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Generates an Ed25519 Stellar keypair (`G...` public key and `S...` secret seed)
 * using WebCrypto for unit tests and cryptographic signature verification.
 */
export async function generateStellarTestKeypair(): Promise<StellarTestKeypair> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error('WebCrypto subtle API is required to generate an Ed25519 keypair.');
  }

  const keyPair = (await subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const spkiBuffer = new Uint8Array(await subtle.exportKey('spki', keyPair.publicKey));
  const pkcs8Buffer = new Uint8Array(await subtle.exportKey('pkcs8', keyPair.privateKey));

  const rawPublicKey = spkiBuffer.slice(spkiBuffer.length - 32);
  const rawSecretSeed = pkcs8Buffer.slice(pkcs8Buffer.length - 32);

  const publicKey = encodeStellarPublicKey(rawPublicKey);
  const secretKey = encodeStellarSecretSeed(rawSecretSeed);

  const sign = async (message: string | Uint8Array): Promise<string> => {
    const data =
      typeof message === 'string' ? new TextEncoder().encode(message) : message;
    const sigBuffer = await subtle.sign({ name: 'Ed25519' }, keyPair.privateKey, data);
    return bytesToBase64(new Uint8Array(sigBuffer));
  };

  return {
    publicKey,
    secretKey,
    rawPublicKey,
    rawSecretSeed,
    sign,
  };
}

/**
 * Signs a challenge string using a Stellar `S...` secret key or `StellarTestKeypair`.
 */
export async function signChallengeWithSecretKey(
  challenge: string,
  secretKeyOrPair: string | StellarTestKeypair
): Promise<string> {
  if (typeof secretKeyOrPair !== 'string') {
    return secretKeyOrPair.sign(challenge);
  }

  const rawSeed = decodeStellarSecretSeed(secretKeyOrPair);
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + rawSeed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(rawSeed, ED25519_PKCS8_PREFIX.length);

  const subtle = globalThis.crypto.subtle;
  const privateKey = await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const data = new TextEncoder().encode(challenge);
  const signatureBuffer = await subtle.sign({ name: 'Ed25519' }, privateKey, data);
  return bytesToBase64(new Uint8Array(signatureBuffer));
}

/**
 * Cryptographically verifies an Ed25519 signature over `challenge` against a Stellar `G...` public key.
 */
export async function verifyStellarSignature(params: {
  publicKey: string;
  challenge: string;
  signature: string;
  maxAgeMs?: number;
  now?: number;
}): Promise<boolean> {
  const {
    publicKey,
    challenge,
    signature,
    maxAgeMs = DEFAULT_CHALLENGE_TTL_MS,
    now = Date.now(),
  } = params;

  if (!publicKey || !isValidEd25519PublicKey(publicKey.trim())) {
    return false;
  }
  if (!challenge || !signature) {
    return false;
  }

  // Validate challenge timestamp freshness if embedded in challenge
  const tsMatch = challenge.match(/Timestamp:\s*(\d+)/i);
  if (tsMatch) {
    const challengeTs = Number(tsMatch[1]);
    if (!Number.isFinite(challengeTs) || Math.abs(now - challengeTs) > maxAgeMs) {
      return false;
    }
  }

  try {
    const rawPub = decodeStellarPublicKey(publicKey);
    const spki = new Uint8Array(ED25519_SPKI_PREFIX.length + rawPub.length);
    spki.set(ED25519_SPKI_PREFIX, 0);
    spki.set(rawPub, ED25519_SPKI_PREFIX.length);

    const sigBytes = base64ToBytes(signature);
    if (sigBytes.length !== 64) {
      return false;
    }

    const subtle = globalThis.crypto.subtle;
    const cryptoKey = await subtle.importKey('spki', spki, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    const messageBytes = new TextEncoder().encode(challenge);
    return await subtle.verify({ name: 'Ed25519' }, cryptoKey, sigBytes, messageBytes);
  } catch {
    return false;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

function computeSimpleDigest(canonicalJson: string): string {
  // Deterministic FNV-1a 64-bit style hex digest for synchronous challenge construction
  let h1 = 0xdeadbeef ^ canonicalJson.length;
  let h2 = 0x41c6ce57 ^ canonicalJson.length;
  for (let i = 0; i < canonicalJson.length; i++) {
    const ch = canonicalJson.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Builds a timestamped non-custodial challenge payload for sensitive rule or webhook mutations.
 */
export function createSignatureChallenge(params: {
  action: MutationActionType | string;
  payload: unknown;
  publicKey: string;
  timestamp?: number;
  nonce?: string;
}): SignatureChallenge {
  const cleanKey = params.publicKey?.trim() ?? '';
  if (!isValidEd25519PublicKey(cleanKey)) {
    throw new SignatureGuardError(
      'INVALID_PUBLIC_KEY',
      'A valid Stellar Ed25519 public key (G...) is required to generate a signature challenge.'
    );
  }

  const timestamp = params.timestamp ?? Date.now();
  const nonce = params.nonce ?? `nonce-${timestamp}-${Math.random().toString(36).slice(2, 10)}`;
  const canonicalPayload = stableStringify(params.payload ?? {});
  const payloadDigest = computeSimpleDigest(canonicalPayload);

  const challenge = [
    'Stellar Alerts Non-Custodial Mutation Challenge',
    `Action: ${params.action}`,
    `PublicKey: ${cleanKey}`,
    `Timestamp: ${timestamp}`,
    `Nonce: ${nonce}`,
    `PayloadDigest: ${payloadDigest}`,
    `Payload: ${canonicalPayload}`,
  ].join('\n');

  return {
    challenge,
    action: params.action,
    publicKey: cleanKey,
    timestamp,
    nonce,
    payloadDigest,
  };
}

/**
 * Formats the `X-Stellar-Signature` header value containing publicKey, timestamp, and signature.
 */
export function formatSignatureHeader(params: {
  publicKey: string;
  signature: string;
  timestamp: number;
  action?: string;
}): string {
  const parts = [
    `pub=${params.publicKey}`,
    `ts=${params.timestamp}`,
    ...(params.action ? [`action=${params.action}`] : []),
    `sig=${params.signature}`,
  ];
  return parts.join(';');
}

/**
 * Parses an `X-Stellar-Signature` header back into its structured components.
 */
export function parseSignatureHeader(headerValue: string): {
  publicKey?: string;
  timestamp?: number;
  action?: string;
  signature: string;
} {
  const trimmed = headerValue.trim();
  if (!trimmed.includes('sig=')) {
    return { signature: trimmed };
  }
  const map: Record<string, string> = {};
  for (const segment of trimmed.split(';')) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex > 0) {
      const key = segment.slice(0, eqIndex).trim();
      const val = segment.slice(eqIndex + 1).trim();
      map[key] = val;
    }
  }
  return {
    publicKey: map.pub,
    timestamp: map.ts ? Number(map.ts) : undefined,
    action: map.action,
    signature: map.sig ?? trimmed,
  };
}

interface GlobalWalletWindow {
  freighterApi?: {
    signMessage?: (message: string) => Promise<string | { signedMessage?: string; error?: string }>;
    getPublicKey?: () => Promise<string>;
  };
  albedo?: {
    signMessage?: (params: { message: string; pubkey?: string }) => Promise<{
      message_signature?: string;
      signature?: string;
      pubkey?: string;
    }>;
  };
}

function isRejectionError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err ?? '');
  return /reject|declin|cancel|denied|aborted/i.test(msg);
}

/**
 * Requests the connected non-custodial wallet (Freighter, Albedo, or custom signer)
 * to sign a timestamped challenge before executing a sensitive mutation.
 */
export async function requestWalletSignature(
  options: RequestWalletSignatureOptions
): Promise<SignedMutationProof> {
  const provider: WalletProviderType =
    options.provider ?? (options.signer ? 'custom' : 'freighter');

  const challengeObj =
    options.challengeOverride ??
    createSignatureChallenge({
      action: options.action,
      payload: options.payload,
      publicKey: options.publicKey,
      timestamp: options.timestamp,
      nonce: options.nonce,
    });

  let rawSignature: string | undefined;

  try {
    if (options.signer) {
      const res = await options.signer(challengeObj.challenge, {
        publicKey: challengeObj.publicKey,
        provider,
        action: challengeObj.action,
      });
      rawSignature = typeof res === 'string' ? res : res?.signature;
    } else if (provider === 'albedo') {
      const win = (typeof window !== 'undefined' ? window : undefined) as
        | GlobalWalletWindow
        | undefined;
      const albedo = win?.albedo;
      if (!albedo || typeof albedo.signMessage !== 'function') {
        throw new SignatureGuardError(
          'WALLET_NOT_FOUND',
          'Albedo wallet provider is not available in this browser.'
        );
      }
      const res = await albedo.signMessage({
        message: challengeObj.challenge,
        pubkey: challengeObj.publicKey,
      });
      rawSignature = res?.message_signature ?? res?.signature;
    } else {
      const win = (typeof window !== 'undefined' ? window : undefined) as
        | GlobalWalletWindow
        | undefined;
      const freighter = win?.freighterApi;
      if (!freighter || typeof freighter.signMessage !== 'function') {
        throw new SignatureGuardError(
          'WALLET_NOT_FOUND',
          'Freighter wallet extension is not available to sign the challenge.'
        );
      }
      const res = await freighter.signMessage(challengeObj.challenge);
      if (typeof res === 'string') {
        rawSignature = res;
      } else if (res && typeof res === 'object') {
        if (res.error) {
          throw new Error(res.error);
        }
        rawSignature = res.signedMessage;
      }
    }
  } catch (err) {
    if (err instanceof SignatureGuardError) {
      throw err;
    }
    if (isRejectionError(err)) {
      throw new SignatureGuardError(
        'USER_REJECTED',
        'Signature request was rejected or cancelled by the user.'
      );
    }
    throw new SignatureGuardError(
      'USER_REJECTED',
      err instanceof Error ? err.message : 'Wallet failed to sign the challenge.'
    );
  }

  if (!rawSignature || typeof rawSignature !== 'string' || !rawSignature.trim()) {
    throw new SignatureGuardError(
      'USER_REJECTED',
      'Wallet returned an empty signature for the challenge.'
    );
  }

  const signature = rawSignature.trim();

  if (options.verifyCryptographically) {
    const valid = await verifyStellarSignature({
      publicKey: challengeObj.publicKey,
      challenge: challengeObj.challenge,
      signature,
    });
    if (!valid) {
      throw new SignatureGuardError(
        'SIGNATURE_INVALID',
        'Cryptographic Ed25519 verification failed for the provided wallet signature.'
      );
    }
  }

  const headerValue = formatSignatureHeader({
    publicKey: challengeObj.publicKey,
    signature,
    timestamp: challengeObj.timestamp,
    action: challengeObj.action,
  });

  return {
    publicKey: challengeObj.publicKey,
    signature,
    challenge: challengeObj.challenge,
    timestamp: challengeObj.timestamp,
    action: challengeObj.action,
    provider,
    headerValue,
  };
}

/**
 * Builds the HTTP headers map including `X-Stellar-Signature` for backend verification.
 */
export function buildSignatureHeaders(
  proof: SignedMutationProof,
  extraHeaders: Record<string, string> = {}
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    [STELLAR_SIGNATURE_HEADER]: proof.headerValue,
    [STELLAR_PUBLIC_KEY_HEADER]: proof.publicKey,
    [STELLAR_TIMESTAMP_HEADER]: String(proof.timestamp),
    [STELLAR_CHALLENGE_HEADER]: bytesToBase64(new TextEncoder().encode(proof.challenge)),
    ...extraHeaders,
  };
}

/**
 * Executes a guarded API mutation request with the `X-Stellar-Signature` header attached.
 */
export async function submitSignedMutation<TResponse = unknown>(
  options: SubmitSignedMutationOptions
): Promise<TResponse> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const method = options.method ?? 'POST';
  const headers = buildSignatureHeaders(options.proof, options.headers);

  let response: Response;
  try {
    response = await fetchFn(options.endpoint, {
      method,
      headers,
      body: JSON.stringify(options.payload),
    });
  } catch (err) {
    throw new SignatureGuardError(
      'MUTATION_FAILED',
      err instanceof Error ? err.message : 'Failed to reach the API server.'
    );
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorMessage =
      (data as { error?: string; message?: string })?.error ||
      (data as { error?: string; message?: string })?.message ||
      `Mutation rejected with status ${response.status}`;
    throw new SignatureGuardError('MUTATION_FAILED', errorMessage);
  }

  return data as TResponse;
}
