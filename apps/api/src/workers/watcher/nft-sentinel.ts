import * as StellarSdk from 'stellar-sdk';

/**
 * [SEP-0041] Soroban Non-Fungible Token (NFT) Transfer & Minting Event Sentinel.
 *
 * Decodes SEP-0041 compliant NFT events ('transfer', 'mint', 'burn', 'set_uri')
 * emitted by Soroban NFT smart contracts. Extracts token IDs (across ScVal u32,
 * u64, u128, i128, string, symbol, bytes representations), sender/receiver public
 * keys, and metadata URI updates. Generates structured alert assessments with
 * explorer links and notification formats.
 */

const TAG = '[NftSentinel]';

export type NftEventType = 'TRANSFER' | 'MINT' | 'BURN' | 'METADATA_UPDATE';

export interface ParsedNftEvent {
  contractId: string;
  eventType: NftEventType;
  tokenId: string;
  from: string | null;
  to: string | null;
  metadataUri?: string | null;
  ledgerSeq?: number;
  txHash?: string;
  rawMetadata?: Record<string, unknown>;
}

export interface NftAlertAssessment {
  event: 'soroban.nft_event';
  contractId: string;
  eventType: NftEventType;
  tokenId: string;
  from: string | null;
  to: string | null;
  metadataUri?: string | null;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  message: string;
  explorerUrl: string;
  txExplorerUrl?: string;
  accountExplorerUrls?: {
    from?: string;
    to?: string;
  };
  ledgerSeq?: number;
  txHash?: string;
  metadata?: Record<string, unknown>;
}

const ACTION_MAP: Record<string, NftEventType> = {
  transfer: 'TRANSFER',
  nft_transfer: 'TRANSFER',
  mint: 'MINT',
  nft_mint: 'MINT',
  burn: 'BURN',
  nft_burn: 'BURN',
  set_uri: 'METADATA_UPDATE',
  set_token_uri: 'METADATA_UPDATE',
  update_metadata: 'METADATA_UPDATE',
  metadata_update: 'METADATA_UPDATE',
  token_uri: 'METADATA_UPDATE',
};

/**
 * Decodes a single topic entry into a clean string representation.
 * Handles plain strings, { symbol: '...' } shapes, parsed ScVal unions,
 * and base64-XDR serialized ScVal blobs.
 */
export function decodeTopicValue(topicEntry: any): string | null {
  if (topicEntry === null || topicEntry === undefined) return null;

  if (typeof topicEntry === 'string') {
    // Check if it might be base64-encoded XDR
    if (
      topicEntry.length >= 4 &&
      topicEntry.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(topicEntry)
    ) {
      try {
        const scVal = StellarSdk.xdr.ScVal.fromXDR(topicEntry, 'base64');
        const native = StellarSdk.scValToNative(scVal);
        if (typeof native === 'string') return native;
        if (typeof native === 'symbol') return native.description ?? String(native);
      } catch {
        // Fall through - it was just a plain string that happened to look like base64
      }
    }
    return topicEntry;
  }

  if (typeof topicEntry === 'object') {
    if (typeof topicEntry.symbol === 'string' && topicEntry.symbol) {
      return topicEntry.symbol;
    }
    if (
      (topicEntry.type === 'symbol' || topicEntry.type === 'string') &&
      typeof topicEntry.value === 'string'
    ) {
      return topicEntry.value;
    }
    try {
      const native = StellarSdk.scValToNative(topicEntry);
      if (typeof native === 'string') return native;
      if (typeof native === 'symbol') return native.description ?? String(native);
      if (typeof native === 'number' || typeof native === 'bigint') return native.toString();
    } catch {
      // Best-effort
    }
  }

  return null;
}

/**
 * Decodes action name from topic[0] into a canonical NftEventType.
 */
export function decodeAction(topic0: any): NftEventType | null {
  const decoded = decodeTopicValue(topic0);
  if (!decoded) return null;
  const normalized = decoded.trim().toLowerCase();
  return ACTION_MAP[normalized] ?? null;
}

/**
 * Decodes a Stellar account or contract address from various inputs:
 * strkey string ('G...', 'C...'), base64-XDR ScVal, or parsed ScVal object.
 */
export function decodeNftAddress(entry: any): string | null {
  if (entry === null || entry === undefined) return null;

  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (trimmed.startsWith('G') || trimmed.startsWith('C')) {
      return trimmed;
    }
    // Attempt base64 XDR decode
    if (
      trimmed.length >= 4 &&
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ) {
      try {
        const scVal = StellarSdk.xdr.ScVal.fromXDR(trimmed, 'base64');
        return decodeNftAddress(scVal);
      } catch {
        // Not a valid base64 ScVal
      }
    }
    return null;
  }

  if (typeof entry === 'object') {
    try {
      const native = StellarSdk.scValToNative(entry);
      if (typeof native === 'string' && (native.startsWith('G') || native.startsWith('C'))) {
        return native;
      }
      if (native && typeof native === 'object' && typeof (native as any).address === 'string') {
        const addr = (native as any).address;
        if (addr.startsWith('G') || addr.startsWith('C')) {
          return addr;
        }
      }
    } catch {
      // Best-effort
    }

    try {
      return StellarSdk.Address.fromScVal(entry).toString();
    } catch {
      // Best-effort
    }

    // Direct object shape e.g. { address: 'G...' }
    if (typeof entry.address === 'string' && (entry.address.startsWith('G') || entry.address.startsWith('C'))) {
      return entry.address;
    }
  }

  return null;
}

/**
 * Helper to convert a byte buffer/Uint8Array to either an ASCII string or hex representation.
 */
function bufferToIdentifier(buf: Buffer | Uint8Array): string {
  const nodeBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const text = nodeBuf.toString('utf8');
  // If printable ASCII, return readable text
  if (/^[\x20-\x7E]+$/.test(text)) {
    return text;
  }
  return `0x${nodeBuf.toString('hex')}`;
}

/**
 * Extracts a token ID string from diverse inputs:
 * - ScVal u32, u64, u128, i128, string, symbol, bytes
 * - Plain JS number, bigint, string
 * - Object or Map containing { token_id, tokenId, id, token, value }
 * - Base64 XDR ScVal strings
 */
export function extractTokenId(value: any): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value).toString() : null;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Check if it's base64-encoded ScVal XDR
    if (
      trimmed.length >= 4 &&
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ) {
      try {
        const scVal = StellarSdk.xdr.ScVal.fromXDR(trimmed, 'base64');
        const extracted = extractTokenId(scVal);
        if (extracted !== null) return extracted;
      } catch {
        // Plain string
      }
    }
    return trimmed;
  }

  if (typeof value === 'object') {
    // If it's a Buffer or Uint8Array directly
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return bufferToIdentifier(value);
    }

    // Try scValToNative first
    try {
      const native = StellarSdk.scValToNative(value);
      if (typeof native === 'number') {
        return Math.trunc(native).toString();
      }
      if (typeof native === 'bigint') {
        return native.toString();
      }
      if (typeof native === 'string') {
        return native;
      }
      if (typeof native === 'symbol') {
        return native.description ?? String(native);
      }
      if (Buffer.isBuffer(native) || native instanceof Uint8Array) {
        return bufferToIdentifier(native);
      }
      if (native && typeof native === 'object') {
        const candidate =
          native.token_id ??
          native.tokenId ??
          native.id ??
          native.token ??
          native.value;
        if (candidate !== undefined) {
          const res = extractTokenId(candidate);
          if (res !== null) return res;
        }
      }
    } catch {
      // Best-effort
    }

    // Plain JS object fields
    const directCandidate =
      value.token_id ??
      value.tokenId ??
      value.id ??
      value.token ??
      value.edition ??
      value.value;
    if (directCandidate !== undefined) {
      const res = extractTokenId(directCandidate);
      if (res !== null) return res;
    }

    // Inspect ScMap entries if present
    if (Array.isArray(value.map) || Array.isArray(value)) {
      const entries = Array.isArray(value.map) ? value.map : value;
      for (const entry of entries) {
        if (entry && typeof entry === 'object' && 'key' in entry && 'val' in entry) {
          const keyStr = decodeTopicValue(entry.key)?.toLowerCase();
          if (keyStr === 'token_id' || keyStr === 'tokenid' || keyStr === 'id') {
            return extractTokenId(entry.val);
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extracts a metadata URI string from an event payload or object.
 */
export function extractMetadataUri(value: any): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      trimmed.startsWith('ipfs://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('ar://') ||
      trimmed.startsWith('data:')
    ) {
      return trimmed;
    }
    // Attempt base64 ScVal decode
    if (
      trimmed.length >= 4 &&
      trimmed.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)
    ) {
      try {
        const scVal = StellarSdk.xdr.ScVal.fromXDR(trimmed, 'base64');
        return extractMetadataUri(scVal);
      } catch {
        // Return string if valid
      }
    }
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'object') {
    try {
      const native = StellarSdk.scValToNative(value);
      if (typeof native === 'string') {
        return extractMetadataUri(native);
      }
      if (native && typeof native === 'object') {
        const candidate =
          native.uri ??
          native.metadata_uri ??
          native.metadataUri ??
          native.url ??
          native.token_uri ??
          native.tokenUri;
        if (candidate) return extractMetadataUri(candidate);
      }
    } catch {
      // Best-effort
    }

    const candidate =
      value.uri ??
      value.metadata_uri ??
      value.metadataUri ??
      value.url ??
      value.token_uri ??
      value.tokenUri;
    if (candidate) {
      return extractMetadataUri(candidate);
    }
  }

  return null;
}

/**
 * Builds explorer URL for a Soroban contract.
 */
export function buildContractExplorerUrl(contractId: string, network = 'public'): string {
  const net = network === 'testnet' ? 'testnet' : 'public';
  return `https://stellar.expert/explorer/${net}/contract/${contractId}`;
}

/**
 * Builds explorer URL for a transaction.
 */
export function buildTxExplorerUrl(txHash: string, network = 'public'): string {
  const net = network === 'testnet' ? 'testnet' : 'public';
  return `https://stellar.expert/explorer/${net}/tx/${txHash}`;
}

/**
 * Builds explorer URL for an account or contract address.
 */
export function buildAccountExplorerUrl(address: string, network = 'public'): string {
  const net = network === 'testnet' ? 'testnet' : 'public';
  const segment = address.startsWith('C') ? 'contract' : 'account';
  return `https://stellar.expert/explorer/${net}/${segment}/${address}`;
}

/**
 * Parses an incoming Soroban RPC event into a structured ParsedNftEvent.
 * Returns null if the event does not represent a valid SEP-0041 NFT event.
 */
export function parseNftEvent(event: any): ParsedNftEvent | null {
  if (!event || !event.topic) return null;

  const topics = Array.isArray(event.topic)
    ? event.topic
    : typeof event.topic === 'string'
      ? [event.topic]
      : [];

  if (topics.length === 0) return null;

  const eventType = decodeAction(topics[0]);
  if (!eventType) return null;

  const contractId = typeof event.contractId === 'string' ? event.contractId : '';
  const valuePayload = event.value ?? event.data ?? {};

  let from: string | null = null;
  let to: string | null = null;
  let tokenId: string | null = null;
  let metadataUri: string | null = null;

  switch (eventType) {
    case 'TRANSFER': {
      // Case 1: topics = ['transfer', from, to] with value = tokenId
      // Case 2: topics = ['transfer', from, to, tokenId]
      // Case 3: topics = ['transfer'], value = { from, to, tokenId }
      from =
        (topics.length > 1 ? decodeNftAddress(topics[1]) : null) ??
        decodeNftAddress(valuePayload.from ?? valuePayload.sender);

      to =
        (topics.length > 2 ? decodeNftAddress(topics[2]) : null) ??
        decodeNftAddress(valuePayload.to ?? valuePayload.recipient ?? valuePayload.receiver);

      if (topics.length > 3) {
        tokenId = extractTokenId(topics[3]);
      }
      if (!tokenId) {
        tokenId = extractTokenId(valuePayload);
      }
      break;
    }

    case 'MINT': {
      // Case 1: topics = ['mint', to] with value = tokenId
      // Case 2: topics = ['mint', admin, to] with value = tokenId
      // Case 3: topics = ['mint', to, tokenId]
      // Case 4: topics = ['mint'], value = { to, tokenId, admin? }
      if (topics.length >= 3) {
        const addr1 = decodeNftAddress(topics[1]);
        const addr2 = decodeNftAddress(topics[2]);
        if (addr1 && addr2) {
          from = addr1; // admin/minter
          to = addr2;   // recipient
          if (topics.length > 3) {
            tokenId = extractTokenId(topics[3]);
          }
        } else if (addr1 && !addr2) {
          to = addr1;
          tokenId = extractTokenId(topics[2]);
        }
      } else if (topics.length === 2) {
        to = decodeNftAddress(topics[1]);
      }

      if (!to) {
        to = decodeNftAddress(valuePayload.to ?? valuePayload.recipient ?? valuePayload.receiver);
      }
      if (!from && valuePayload.admin) {
        from = decodeNftAddress(valuePayload.admin);
      }
      if (!tokenId) {
        tokenId = extractTokenId(valuePayload);
      }
      break;
    }

    case 'BURN': {
      // Case 1: topics = ['burn', from] with value = tokenId
      // Case 2: topics = ['burn', admin, from] with value = tokenId
      // Case 3: topics = ['burn', from, tokenId]
      // Case 4: topics = ['burn'], value = { from, tokenId }
      if (topics.length >= 3) {
        const addr1 = decodeNftAddress(topics[1]);
        const addr2 = decodeNftAddress(topics[2]);
        if (addr1 && addr2) {
          to = addr1;   // admin
          from = addr2; // burned from
          if (topics.length > 3) {
            tokenId = extractTokenId(topics[3]);
          }
        } else if (addr1 && !addr2) {
          from = addr1;
          tokenId = extractTokenId(topics[2]);
        }
      } else if (topics.length === 2) {
        from = decodeNftAddress(topics[1]);
      }

      if (!from) {
        from = decodeNftAddress(valuePayload.from ?? valuePayload.owner);
      }
      if (!tokenId) {
        tokenId = extractTokenId(valuePayload);
      }
      break;
    }

    case 'METADATA_UPDATE': {
      // Case 1: topics = ['set_uri', tokenId], value = uri
      // Case 2: topics = ['set_uri'], value = { token_id, uri }
      // Case 3: topics = ['set_uri', tokenId, uri]
      if (topics.length > 1) {
        tokenId = extractTokenId(topics[1]);
      }
      if (topics.length > 2) {
        metadataUri = extractMetadataUri(topics[2]);
      }

      if (!tokenId) {
        tokenId = extractTokenId(valuePayload);
      }
      if (!metadataUri) {
        metadataUri = extractMetadataUri(valuePayload);
      }
      break;
    }
  }

  // Token ID is required for a valid NFT event
  if (!tokenId) {
    return null;
  }

  return {
    contractId,
    eventType,
    tokenId,
    from,
    to,
    metadataUri,
    ledgerSeq: event.ledgerSeq ?? event.ledger ?? undefined,
    txHash: event.txHash ?? event.transactionHash ?? undefined,
    rawMetadata: typeof valuePayload === 'object' && valuePayload !== null ? valuePayload : {},
  };
}

/**
 * Formats a short address/contract for display (e.g. "GBRP...OX2H").
 */
function shortAddr(addr: string | null | undefined): string {
  if (!addr) return 'Unknown';
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

/**
 * Engine that evaluates parsed NFT events and formats notifications and metadata.
 */
export class NftSentinelEngine {
  private network: string;

  constructor(network = process.env.STELLAR_NETWORK || 'public') {
    this.network = network;
  }

  /**
   * Generates a structured NftAlertAssessment from a parsed NFT event.
   */
  public assessNftEvent(parsed: ParsedNftEvent): NftAlertAssessment {
    const explorerUrl = buildContractExplorerUrl(parsed.contractId, this.network);
    const txExplorerUrl = parsed.txHash
      ? buildTxExplorerUrl(parsed.txHash, this.network)
      : undefined;

    const accountExplorerUrls: { from?: string; to?: string } = {};
    if (parsed.from) {
      accountExplorerUrls.from = buildAccountExplorerUrl(parsed.from, this.network);
    }
    if (parsed.to) {
      accountExplorerUrls.to = buildAccountExplorerUrl(parsed.to, this.network);
    }

    let message = '';
    const shortContract = shortAddr(parsed.contractId);

    switch (parsed.eventType) {
      case 'TRANSFER': {
        const shortFrom = shortAddr(parsed.from);
        const shortTo = shortAddr(parsed.to);
        message = `[NFT Transfer] Collection ${shortContract} Token #${parsed.tokenId} transferred from ${shortFrom} to ${shortTo}`;
        break;
      }
      case 'MINT': {
        const shortTo = shortAddr(parsed.to);
        message = `[NFT Mint] Collection ${shortContract} Token #${parsed.tokenId} minted to ${shortTo}`;
        break;
      }
      case 'BURN': {
        const shortFrom = shortAddr(parsed.from);
        message = `[NFT Burn] Collection ${shortContract} Token #${parsed.tokenId} burned by ${shortFrom}`;
        break;
      }
      case 'METADATA_UPDATE': {
        message = `[NFT Metadata Update] Collection ${shortContract} Token #${parsed.tokenId} URI updated: ${parsed.metadataUri || 'None'}`;
        break;
      }
    }

    return {
      event: 'soroban.nft_event',
      contractId: parsed.contractId,
      eventType: parsed.eventType,
      tokenId: parsed.tokenId,
      from: parsed.from,
      to: parsed.to,
      metadataUri: parsed.metadataUri ?? null,
      severity: 'INFO',
      message,
      explorerUrl,
      txExplorerUrl,
      accountExplorerUrls,
      ledgerSeq: parsed.ledgerSeq,
      txHash: parsed.txHash,
      metadata: parsed.rawMetadata,
    };
  }

  /**
   * Processes an array of raw RPC events and returns assessments for valid NFT events.
   */
  public processBatch(rawEvents: any[]): NftAlertAssessment[] {
    const assessments: NftAlertAssessment[] = [];
    for (const raw of rawEvents) {
      const parsed = parseNftEvent(raw);
      if (parsed) {
        assessments.push(this.assessNftEvent(parsed));
      }
    }
    return assessments;
  }
}

/** Singleton instance with default network configuration. */
export const nftSentinelEngine = new NftSentinelEngine();

/**
 * Registers supervisor heartbeat if running under WorkerSupervisor child process.
 */
export function registerSupervisorHeartbeat(): void {
  if (process.send) {
    process.on('message', (message: any) => {
      if (message === 'ping' || message?.type === 'ping') {
        process.send?.({ type: 'pong', pid: process.pid });
      }
    });
  }
}
