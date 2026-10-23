import { describe, expect, it } from 'vitest';
import * as StellarSdk from 'stellar-sdk';
import {
  decodeAction,
  decodeNftAddress,
  decodeTopicValue,
  extractMetadataUri,
  extractTokenId,
  nftSentinelEngine,
  NftSentinelEngine,
  parseNftEvent,
  buildAccountExplorerUrl,
  buildContractExplorerUrl,
  buildTxExplorerUrl,
} from '../nft-sentinel';
import { NftRuleEvaluator, nftRuleEvaluator } from '../../../modules/alerts/rules/nft.rule';

const ALICE_PUBKEY = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const BOB_PUBKEY = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const CHARLIE_PUBKEY = 'GCFXHS4GMXBYRBAP5GSGMEB67DZZIC2QUFNA4AB5MAKG2CGWAGPB6USV';
const NFT_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const OTHER_CONTRACT = 'CBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OAAA';

function toScAddress(strkey: string): StellarSdk.xdr.ScVal {
  return StellarSdk.Address.fromString(strkey).toScVal();
}

function toBase64Xdr(scVal: StellarSdk.xdr.ScVal): string {
  return scVal.toXDR('base64');
}

describe('NftSentinel: Topic and Value Decoders', () => {
  it('decodes plain strings and symbol ScVal topic entries', () => {
    expect(decodeTopicValue('transfer')).toBe('transfer');
    expect(decodeTopicValue({ symbol: 'mint' })).toBe('mint');
    expect(decodeTopicValue({ type: 'symbol', value: 'burn' })).toBe('burn');

    const scv = StellarSdk.xdr.ScVal.scvSymbol('nft_mint');
    expect(decodeTopicValue(scv)).toBe('nft_mint');

    const b64 = toBase64Xdr(scv);
    expect(decodeTopicValue(b64)).toBe('nft_mint');
  });

  it('normalizes action symbols into canonical NftEventType', () => {
    expect(decodeAction('transfer')).toBe('TRANSFER');
    expect(decodeAction('nft_transfer')).toBe('TRANSFER');
    expect(decodeAction('mint')).toBe('MINT');
    expect(decodeAction('nft_mint')).toBe('MINT');
    expect(decodeAction('burn')).toBe('BURN');
    expect(decodeAction('nft_burn')).toBe('BURN');
    expect(decodeAction('set_uri')).toBe('METADATA_UPDATE');
    expect(decodeAction('update_metadata')).toBe('METADATA_UPDATE');
    expect(decodeAction('token_uri')).toBe('METADATA_UPDATE');

    expect(decodeAction('swap')).toBeNull();
    expect(decodeAction('deposit')).toBeNull();
    expect(decodeAction(null)).toBeNull();
  });

  it('decodes Stellar account and contract addresses across various formats', () => {
    // Strkeys
    expect(decodeNftAddress(ALICE_PUBKEY)).toBe(ALICE_PUBKEY);
    expect(decodeNftAddress(NFT_CONTRACT)).toBe(NFT_CONTRACT);

    // ScVal
    const aliceScv = toScAddress(ALICE_PUBKEY);
    expect(decodeNftAddress(aliceScv)).toBe(ALICE_PUBKEY);

    // Base64-XDR
    const aliceB64 = toBase64Xdr(aliceScv);
    expect(decodeNftAddress(aliceB64)).toBe(ALICE_PUBKEY);

    // Object shapes
    expect(decodeNftAddress({ address: BOB_PUBKEY })).toBe(BOB_PUBKEY);
    expect(decodeNftAddress(null)).toBeNull();
    expect(decodeNftAddress('invalid-string')).toBeNull();
  });

  it('extracts token IDs across ScVal u32, u64, u128, string, symbol, bytes', () => {
    // u32
    const u32 = StellarSdk.xdr.ScVal.scvU32(42);
    expect(extractTokenId(u32)).toBe('42');
    expect(extractTokenId(toBase64Xdr(u32))).toBe('42');

    // u64
    const u64 = StellarSdk.nativeToScVal(10000000001n, { type: 'u64' });
    expect(extractTokenId(u64)).toBe('10000000001');

    // u128
    const u128 = StellarSdk.nativeToScVal(12345678901234567890n, { type: 'u128' });
    expect(extractTokenId(u128)).toBe('12345678901234567890');

    // string / symbol
    expect(extractTokenId(StellarSdk.xdr.ScVal.scvString('Ape#99'))).toBe('Ape#99');
    expect(extractTokenId(StellarSdk.xdr.ScVal.scvSymbol('badge_1'))).toBe('badge_1');

    // printable bytes
    const textBytes = StellarSdk.xdr.ScVal.scvBytes(Buffer.from('hero_sword'));
    expect(extractTokenId(textBytes)).toBe('hero_sword');

    // non-printable binary bytes
    const binBytes = StellarSdk.xdr.ScVal.scvBytes(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(extractTokenId(binBytes)).toBe('0xdeadbeef');

    // JS primitives
    expect(extractTokenId(123)).toBe('123');
    expect(extractTokenId(999999999999n)).toBe('999999999999');
    expect(extractTokenId('token_abc')).toBe('token_abc');

    // JS object with token_id / tokenId
    expect(extractTokenId({ token_id: 55 })).toBe('55');
    expect(extractTokenId({ tokenId: 'genesis_token' })).toBe('genesis_token');
    expect(extractTokenId({ id: 101 })).toBe('101');

    // Invalid
    expect(extractTokenId(null)).toBeNull();
    expect(extractTokenId({})).toBeNull();
  });

  it('extracts metadata URIs from string, ScVal, and object payloads', () => {
    const ipfs = 'ipfs://QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx';
    const https = 'https://metadata.stellar-alerts.com/nft/1.json';

    expect(extractMetadataUri(ipfs)).toBe(ipfs);
    expect(extractMetadataUri({ uri: ipfs })).toBe(ipfs);
    expect(extractMetadataUri({ metadata_uri: https })).toBe(https);

    const scv = StellarSdk.xdr.ScVal.scvString(ipfs);
    expect(extractMetadataUri(scv)).toBe(ipfs);
    expect(extractMetadataUri(toBase64Xdr(scv))).toBe(ipfs);

    expect(extractMetadataUri(null)).toBeNull();
  });
});

describe('NftSentinel: Event Parser (SEP-0041 Compliance)', () => {
  it('parses standard SEP-0041 transfer event (topics: [transfer, from, to], value: tokenId)', () => {
    const event = {
      contractId: NFT_CONTRACT,
      ledger: 54321,
      txHash: '0x1234abcd',
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('transfer'),
        toScAddress(ALICE_PUBKEY),
        toScAddress(BOB_PUBKEY),
      ],
      value: StellarSdk.xdr.ScVal.scvU32(77),
    };

    const parsed = parseNftEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.eventType).toBe('TRANSFER');
    expect(parsed?.contractId).toBe(NFT_CONTRACT);
    expect(parsed?.from).toBe(ALICE_PUBKEY);
    expect(parsed?.to).toBe(BOB_PUBKEY);
    expect(parsed?.tokenId).toBe('77');
    expect(parsed?.ledgerSeq).toBe(54321);
    expect(parsed?.txHash).toBe('0x1234abcd');
  });

  it('parses base64-XDR encoded transfer event with 4 topics', () => {
    const event = {
      contractId: NFT_CONTRACT,
      ledgerSeq: 88888,
      txHash: '0x9999ffff',
      topic: [
        toBase64Xdr(StellarSdk.xdr.ScVal.scvSymbol('nft_transfer')),
        toBase64Xdr(toScAddress(ALICE_PUBKEY)),
        toBase64Xdr(toScAddress(BOB_PUBKEY)),
        toBase64Xdr(StellarSdk.nativeToScVal(123456789n, { type: 'u64' })),
      ],
      value: null,
    };

    const parsed = parseNftEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.eventType).toBe('TRANSFER');
    expect(parsed?.from).toBe(ALICE_PUBKEY);
    expect(parsed?.to).toBe(BOB_PUBKEY);
    expect(parsed?.tokenId).toBe('123456789');
  });

  it('parses SEP-0041 mint event with admin and recipient', () => {
    const event = {
      contractId: NFT_CONTRACT,
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('mint'),
        toScAddress(ALICE_PUBKEY), // admin
        toScAddress(BOB_PUBKEY),   // recipient
      ],
      value: StellarSdk.xdr.ScVal.scvU32(101),
    };

    const parsed = parseNftEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.eventType).toBe('MINT');
    expect(parsed?.from).toBe(ALICE_PUBKEY);
    expect(parsed?.to).toBe(BOB_PUBKEY);
    expect(parsed?.tokenId).toBe('101');
  });

  it('parses SEP-0041 mint event with single recipient topic', () => {
    const event = {
      contractId: NFT_CONTRACT,
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('mint'),
        toScAddress(BOB_PUBKEY),
      ],
      value: { token_id: 102 },
    };

    const parsed = parseNftEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.eventType).toBe('MINT');
    expect(parsed?.to).toBe(BOB_PUBKEY);
    expect(parsed?.tokenId).toBe('102');
  });

  it('parses SEP-0041 burn event', () => {
    const event = {
      contractId: NFT_CONTRACT,
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('burn'),
        toScAddress(BOB_PUBKEY),
      ],
      value: StellarSdk.xdr.ScVal.scvU32(202),
    };

    const parsed = parseNftEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.eventType).toBe('BURN');
    expect(parsed?.from).toBe(BOB_PUBKEY);
    expect(parsed?.to).toBeNull();
    expect(parsed?.tokenId).toBe('202');
  });

  it('parses metadata URI update event (set_uri / update_metadata)', () => {
    const ipfs = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
    const event = {
      contractId: NFT_CONTRACT,
      topic: [
        StellarSdk.xdr.ScVal.scvSymbol('set_uri'),
        StellarSdk.xdr.ScVal.scvU32(505),
      ],
      value: StellarSdk.xdr.ScVal.scvString(ipfs),
    };

    const parsed = parseNftEvent(event);
    expect(parsed).not.toBeNull();
    expect(parsed?.eventType).toBe('METADATA_UPDATE');
    expect(parsed?.tokenId).toBe('505');
    expect(parsed?.metadataUri).toBe(ipfs);
  });

  it('rejects invalid, malformed, or non-NFT events gracefully', () => {
    expect(parseNftEvent(null)).toBeNull();
    expect(parseNftEvent({})).toBeNull();
    expect(parseNftEvent({ topic: [] })).toBeNull();
    expect(parseNftEvent({ topic: ['swap'] })).toBeNull();
    expect(parseNftEvent({ topic: ['deposit'] })).toBeNull();

    // Event with transfer action but missing token ID everywhere
    const noTokenEvent = {
      contractId: NFT_CONTRACT,
      topic: ['transfer', ALICE_PUBKEY, BOB_PUBKEY],
      value: null,
    };
    expect(parseNftEvent(noTokenEvent)).toBeNull();

    // Corrupt base64 string
    const corruptEvent = {
      contractId: NFT_CONTRACT,
      topic: ['transfer', '%%%invalid_base64%%%'],
      value: null,
    };
    expect(parseNftEvent(corruptEvent)).toBeNull();
  });
});

describe('NftSentinel: Engine Assessment and Formatting', () => {
  it('formats explorer URLs and human-readable alert notifications', () => {
    const engine = new NftSentinelEngine('public');
    const parsed = {
      contractId: NFT_CONTRACT,
      eventType: 'TRANSFER' as const,
      tokenId: '42',
      from: ALICE_PUBKEY,
      to: BOB_PUBKEY,
      txHash: 'abcdef0123456789',
      ledgerSeq: 12345,
    };

    const assessment = engine.assessNftEvent(parsed);
    expect(assessment.event).toBe('soroban.nft_event');
    expect(assessment.contractId).toBe(NFT_CONTRACT);
    expect(assessment.eventType).toBe('TRANSFER');
    expect(assessment.tokenId).toBe('42');
    expect(assessment.explorerUrl).toBe(buildContractExplorerUrl(NFT_CONTRACT, 'public'));
    expect(assessment.txExplorerUrl).toBe(buildTxExplorerUrl('abcdef0123456789', 'public'));
    expect(assessment.accountExplorerUrls?.from).toBe(buildAccountExplorerUrl(ALICE_PUBKEY, 'public'));
    expect(assessment.accountExplorerUrls?.to).toBe(buildAccountExplorerUrl(BOB_PUBKEY, 'public'));
    expect(assessment.message).toContain('[NFT Transfer]');
    expect(assessment.message).toContain('Token #42');
  });

  it('formats MINT and BURN messages accurately', () => {
    const mintAssessment = nftSentinelEngine.assessNftEvent({
      contractId: NFT_CONTRACT,
      eventType: 'MINT',
      tokenId: '1',
      from: null,
      to: BOB_PUBKEY,
    });
    expect(mintAssessment.message).toContain('[NFT Mint]');
    expect(mintAssessment.message).toContain('Token #1 minted to');

    const burnAssessment = nftSentinelEngine.assessNftEvent({
      contractId: NFT_CONTRACT,
      eventType: 'BURN',
      tokenId: '1',
      from: BOB_PUBKEY,
      to: null,
    });
    expect(burnAssessment.message).toContain('[NFT Burn]');
    expect(burnAssessment.message).toContain('Token #1 burned by');
  });

  it('processes a batch of raw RPC events, filtering non-NFT events', () => {
    const batch = [
      {
        contractId: NFT_CONTRACT,
        topic: ['transfer', ALICE_PUBKEY, BOB_PUBKEY],
        value: 10,
      },
      {
        contractId: OTHER_CONTRACT,
        topic: ['swap', ALICE_PUBKEY],
        value: 500,
      },
      {
        contractId: NFT_CONTRACT,
        topic: ['mint', BOB_PUBKEY],
        value: 11,
      },
    ];

    const assessments = nftSentinelEngine.processBatch(batch);
    expect(assessments).toHaveLength(2);
    expect(assessments[0].tokenId).toBe('10');
    expect(assessments[1].tokenId).toBe('11');
  });
});

describe('NftRuleEvaluator: Rule Matching Logic', () => {
  const sampleEvent = {
    contractId: NFT_CONTRACT,
    topic: ['transfer', ALICE_PUBKEY, BOB_PUBKEY],
    value: 500,
    txHash: '0xabc',
  };

  it('returns matched: false when rule is inactive', () => {
    const rule = {
      id: 'rule-1',
      userId: 'user-1',
      isActive: false,
      conditions: {},
    };
    const res = nftRuleEvaluator.evaluate(sampleEvent, rule);
    expect(res.matched).toBe(false);
  });

  it('matches matching collection contract ID and rejects non-matching', () => {
    const matchingRule = {
      id: 'rule-2',
      userId: 'user-1',
      isActive: true,
      conditions: {
        collectionAddresses: [NFT_CONTRACT],
      },
    };
    const matchRes = nftRuleEvaluator.evaluate(sampleEvent, matchingRule);
    expect(matchRes.matched).toBe(true);
    expect(matchRes.deliveryPayload?.contractId).toBe(NFT_CONTRACT);
    expect(matchRes.deliveryPayload?.tokenId).toBe('500');

    const nonMatchingRule = {
      id: 'rule-3',
      userId: 'user-1',
      isActive: true,
      conditions: {
        collectionAddresses: [OTHER_CONTRACT],
      },
    };
    const nonMatchRes = nftRuleEvaluator.evaluate(sampleEvent, nonMatchingRule);
    expect(nonMatchRes.matched).toBe(false);
  });

  it('filters by event type (e.g. MINT vs TRANSFER)', () => {
    const mintOnlyRule = {
      id: 'rule-4',
      userId: 'user-1',
      isActive: true,
      conditions: {
        eventTypes: ['MINT' as const],
      },
    };
    // sampleEvent is a TRANSFER
    expect(nftRuleEvaluator.evaluate(sampleEvent, mintOnlyRule).matched).toBe(false);

    // Provide a MINT event
    const mintEvent = {
      contractId: NFT_CONTRACT,
      topic: ['mint', BOB_PUBKEY],
      value: 501,
    };
    expect(nftRuleEvaluator.evaluate(mintEvent, mintOnlyRule).matched).toBe(true);
  });

  it('filters by participant wallet address (from or to)', () => {
    // Matches ALICE (sender)
    const aliceRule = {
      id: 'rule-alice',
      userId: 'user-1',
      isActive: true,
      conditions: {
        walletAddresses: [ALICE_PUBKEY],
      },
    };
    expect(nftRuleEvaluator.evaluate(sampleEvent, aliceRule).matched).toBe(true);

    // Matches BOB (recipient)
    const bobRule = {
      id: 'rule-bob',
      userId: 'user-1',
      isActive: true,
      conditions: {
        walletAddresses: [BOB_PUBKEY],
      },
    };
    expect(nftRuleEvaluator.evaluate(sampleEvent, bobRule).matched).toBe(true);

    // Rejects CHARLIE (neither)
    const charlieRule = {
      id: 'rule-charlie',
      userId: 'user-1',
      isActive: true,
      conditions: {
        walletAddresses: [CHARLIE_PUBKEY],
      },
    };
    expect(nftRuleEvaluator.evaluate(sampleEvent, charlieRule).matched).toBe(false);
  });

  it('filters by exact token ID and by numeric threshold range', () => {
    // Exact token ID match
    const tokenRule = {
      id: 'rule-token',
      userId: 'user-1',
      isActive: true,
      conditions: {
        tokenIds: ['500'],
      },
    };
    expect(nftRuleEvaluator.evaluate(sampleEvent, tokenRule).matched).toBe(true);

    const tokenRuleOther = {
      id: 'rule-token-other',
      userId: 'user-1',
      isActive: true,
      conditions: {
        tokenIds: ['999'],
      },
    };
    expect(nftRuleEvaluator.evaluate(sampleEvent, tokenRuleOther).matched).toBe(false);

    // Numeric threshold range
    // sampleEvent has tokenId 500
    const minThresholdRule = {
      id: 'rule-min',
      userId: 'user-1',
      isActive: true,
      conditions: {
        minTokenId: 100,
        maxTokenId: 1000,
      },
    };
    expect(nftRuleEvaluator.evaluate(sampleEvent, minThresholdRule).matched).toBe(true);

    const highMinRule = {
      id: 'rule-high-min',
      userId: 'user-1',
      isActive: true,
      conditions: {
        minTokenId: 1000,
      },
    };
    expect(nftRuleEvaluator.evaluate(sampleEvent, highMinRule).matched).toBe(false);

    const lowMaxRule = {
      id: 'rule-low-max',
      userId: 'user-1',
      isActive: true,
      conditions: {
        maxTokenId: 200,
      },
    };
    expect(nftRuleEvaluator.evaluate(sampleEvent, lowMaxRule).matched).toBe(false);
  });

  it('delivers complete deliveryPayload with explorer URLs and metadata', () => {
    const rule = {
      id: 'rule-full',
      userId: 'user-99',
      isActive: true,
      conditions: {},
    };
    const res = nftRuleEvaluator.evaluate(sampleEvent, rule);
    expect(res.matched).toBe(true);
    expect(res.ruleId).toBe('rule-full');
    expect(res.deliveryPayload).toBeDefined();
    expect(res.deliveryPayload?.event).toBe('soroban.nft_event');
    expect(res.deliveryPayload?.userId).toBe('user-99');
    expect(res.deliveryPayload?.contractId).toBe(NFT_CONTRACT);
    expect(res.deliveryPayload?.eventType).toBe('TRANSFER');
    expect(res.deliveryPayload?.tokenId).toBe('500');
    expect(res.deliveryPayload?.from).toBe(ALICE_PUBKEY);
    expect(res.deliveryPayload?.to).toBe(BOB_PUBKEY);
    expect(res.deliveryPayload?.explorerUrl).toContain(NFT_CONTRACT);
    expect(res.deliveryPayload?.message).toContain('[NFT Transfer]');
  });
});
