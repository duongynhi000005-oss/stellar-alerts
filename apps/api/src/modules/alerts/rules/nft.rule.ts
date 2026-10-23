import {
  NftAlertAssessment,
  NftEventType,
  ParsedNftEvent,
  nftSentinelEngine,
  parseNftEvent,
} from '../../../workers/watcher/nft-sentinel';

export interface NftRuleConfig {
  /**
   * Filter alerts by NFT collection contract ID(s).
   * Matches any collection in this list (or single contractId). If empty/omitted, all collections match.
   */
  collectionAddresses?: string[];
  contractId?: string;
  contractIds?: string[];

  /**
   * Filter alerts by specific token ID(s).
   */
  tokenIds?: string[];
  tokenId?: string;

  /**
   * Filter alerts by numeric token ID threshold / range (inclusive).
   * E.g. minTokenId: 1000 fires only for token IDs >= 1000.
   */
  minTokenId?: string | number;
  maxTokenId?: string | number;

  /**
   * Filter alerts by specific NFT lifecycle operations.
   * If omitted or empty, all event types ('TRANSFER', 'MINT', 'BURN', 'METADATA_UPDATE') match.
   */
  eventTypes?: NftEventType[];

  /**
   * Filter alerts by participant wallet address (matches either `from` or `to`).
   */
  walletAddresses?: string[];
  walletAddress?: string;

  /**
   * Minimum alert severity threshold.
   */
  minSeverity?: 'INFO' | 'WARNING' | 'CRITICAL';
}

export interface AlertRuleLike {
  id: string;
  userId: string;
  walletId?: string | null;
  name?: string | null;
  isActive: boolean;
  conditions?: unknown;
}

export interface NftMatchResult {
  matched: boolean;
  ruleId?: string;
  deliveryPayload?: {
    event: 'soroban.nft_event';
    ruleId: string;
    userId: string;
    contractId: string;
    eventType: NftEventType;
    tokenId: string;
    from: string | null;
    to: string | null;
    metadataUri?: string | null;
    severity: string;
    message: string;
    explorerUrl: string;
    txExplorerUrl?: string;
    metadata: Record<string, unknown>;
  };
}

/**
 * Evaluates an incoming Soroban RPC event against an NFT alert rule.
 * Decodes SEP-0041 events and filters on collection, token ID, range threshold,
 * event type, and participant wallets.
 */
export class NftRuleEvaluator {
  public evaluate(rawEvent: any, rule: AlertRuleLike): NftMatchResult {
    if (!rule.isActive) {
      return { matched: false };
    }

    const parsed = parseNftEvent(rawEvent);
    if (!parsed) {
      return { matched: false };
    }

    const config = this.extractRuleConfig(rule);
    if (config) {
      // 1. Collection Address match
      const collections =
        config.collectionAddresses ??
        config.contractIds ??
        (config.contractId ? [config.contractId] : []);

      if (collections.length > 0) {
        const matchesCollection = collections.some(
          (addr) => addr.trim().toLowerCase() === parsed.contractId.trim().toLowerCase(),
        );
        if (!matchesCollection) {
          return { matched: false };
        }
      }

      // 2. Event Type match
      if (config.eventTypes && config.eventTypes.length > 0) {
        if (!config.eventTypes.includes(parsed.eventType)) {
          return { matched: false };
        }
      }

      // 3. Wallet Address match (matches either sender `from` or recipient `to`)
      const wallets =
        config.walletAddresses ??
        (config.walletAddress ? [config.walletAddress] : []);

      if (wallets.length > 0) {
        const matchesWallet = wallets.some((w) => {
          const target = w.trim().toLowerCase();
          const fromMatch = parsed.from && parsed.from.trim().toLowerCase() === target;
          const toMatch = parsed.to && parsed.to.trim().toLowerCase() === target;
          return fromMatch || toMatch;
        });
        if (!matchesWallet) {
          return { matched: false };
        }
      }

      // 4. Exact Token ID match
      const tokenIds =
        config.tokenIds ??
        (config.tokenId ? [config.tokenId] : []);

      if (tokenIds.length > 0) {
        const matchesTokenId = tokenIds.some(
          (id) => String(id).trim() === parsed.tokenId.trim(),
        );
        if (!matchesTokenId) {
          return { matched: false };
        }
      }

      // 5. Numeric Threshold Range match (minTokenId / maxTokenId)
      if (config.minTokenId !== undefined || config.maxTokenId !== undefined) {
        try {
          const numericTokenId = BigInt(parsed.tokenId.replace(/^0x/i, ''));
          if (config.minTokenId !== undefined) {
            const min = BigInt(String(config.minTokenId).replace(/^0x/i, ''));
            if (numericTokenId < min) {
              return { matched: false };
            }
          }
          if (config.maxTokenId !== undefined) {
            const max = BigInt(String(config.maxTokenId).replace(/^0x/i, ''));
            if (numericTokenId > max) {
              return { matched: false };
            }
          }
        } catch {
          // If the token ID is non-numeric, numeric threshold comparisons cannot match
          return { matched: false };
        }
      }
    }

    const assessment = nftSentinelEngine.assessNftEvent(parsed);

    return {
      matched: true,
      ruleId: rule.id,
      deliveryPayload: {
        event: 'soroban.nft_event',
        ruleId: rule.id,
        userId: rule.userId,
        contractId: parsed.contractId,
        eventType: parsed.eventType,
        tokenId: parsed.tokenId,
        from: parsed.from,
        to: parsed.to,
        metadataUri: parsed.metadataUri ?? null,
        severity: assessment.severity,
        message: assessment.message,
        explorerUrl: assessment.explorerUrl,
        txExplorerUrl: assessment.txExplorerUrl,
        metadata: {
          ledgerSeq: parsed.ledgerSeq,
          txHash: parsed.txHash,
          ...(parsed.rawMetadata ?? {}),
        },
      },
    };
  }

  private extractRuleConfig(rule: AlertRuleLike): NftRuleConfig | null {
    if (!rule.conditions || typeof rule.conditions !== 'object') {
      return null;
    }

    const cond = rule.conditions as Record<string, any>;
    if (cond.nft && typeof cond.nft === 'object') {
      return cond.nft as NftRuleConfig;
    }

    if (
      cond.collectionAddresses !== undefined ||
      cond.contractId !== undefined ||
      cond.contractIds !== undefined ||
      cond.tokenIds !== undefined ||
      cond.tokenId !== undefined ||
      cond.minTokenId !== undefined ||
      cond.maxTokenId !== undefined ||
      cond.eventTypes !== undefined ||
      cond.walletAddresses !== undefined ||
      cond.walletAddress !== undefined
    ) {
      return cond as NftRuleConfig;
    }

    return null;
  }
}

/** Default singleton instance. */
export const nftRuleEvaluator = new NftRuleEvaluator();
