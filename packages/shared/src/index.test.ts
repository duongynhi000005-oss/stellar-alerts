import { describe, expect, it } from 'vitest';
import {
  extractAvailableAssets,
  filterPayments,
  isValidPaymentDTO,
  isValidStellarPublicKey,
  isValidUserDTO,
  isValidWalletDTO,
  PaymentDTO,
} from './index';

const VALID_PUBLIC_KEY = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const VALID_TX_HASH = 'a8f3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3';

describe('@stellar-alerts/shared DTOs and validators', () => {
  it('validates Stellar Ed25519 public keys via isValidStellarPublicKey', () => {
    expect(isValidStellarPublicKey(VALID_PUBLIC_KEY)).toBe(true);
    expect(isValidStellarPublicKey('GINVALID')).toBe(false);
  });

  it('validates UserDTO, WalletDTO, and PaymentDTO shapes', () => {
    expect(
      isValidUserDTO({
        id: 'usr_1',
        email: 'dev@stellar-alerts.io',
        createdAt: '2026-10-18T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(isValidUserDTO({ id: 'usr_1', email: 'not-an-email', createdAt: '' })).toBe(false);

    expect(
      isValidWalletDTO({
        id: 'wal_1',
        userId: 'usr_1',
        publicKey: VALID_PUBLIC_KEY,
        label: 'Primary Treasury',
        createdAt: new Date(),
      }),
    ).toBe(true);
    expect(
      isValidWalletDTO({
        id: 'wal_1',
        userId: 'usr_1',
        publicKey: 'bad-key',
        createdAt: new Date(),
      }),
    ).toBe(false);

    expect(
      isValidPaymentDTO({
        id: 'pay_1',
        walletId: 'wal_1',
        txHash: VALID_TX_HASH,
        fromAddress: VALID_PUBLIC_KEY,
        amount: '150.00',
        asset: 'USDC',
        memo: 'invoice-42',
        receivedAt: '2026-10-18T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('filters payments and extracts sorted unique assets', () => {
    const samplePayments: PaymentDTO[] = [
      {
        id: 'p1',
        walletId: 'w1',
        txHash: VALID_TX_HASH,
        fromAddress: VALID_PUBLIC_KEY,
        amount: 100,
        asset: 'usdc',
        memo: 'alpha',
        receivedAt: '2026-10-18T00:00:00.000Z',
      },
      {
        id: 'p2',
        walletId: 'w1',
        txHash: VALID_TX_HASH,
        fromAddress: VALID_PUBLIC_KEY,
        amount: 50,
        asset: 'XLM',
        memo: 'beta',
        receivedAt: '2026-10-18T00:00:00.000Z',
      },
    ];

    expect(extractAvailableAssets(samplePayments)).toEqual(['ALL', 'USDC', 'XLM']);
    expect(filterPayments(samplePayments, 'alpha', 'ALL')).toHaveLength(1);
    expect(filterPayments(samplePayments, '', 'XLM')).toHaveLength(1);
  });
});
