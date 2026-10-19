import { describe, expect, it } from 'vitest';
import {
  UserDTO,
  WalletDTO,
  PaymentDTO,
  DeliveryEventDTO,
  NotificationPreferenceDTO,
  userDtoSchema,
  walletDtoSchema,
  paymentDtoSchema,
  deliveryEventDtoSchema,
  notificationPreferenceDtoSchema,
  webhookDtoSchema,
  requestLinkDtoSchema,
  verifyLinkDtoSchema,
  didChallengeDtoSchema,
  didVerifyDtoSchema,
  createWalletDtoSchema,
  isValidUserDTO,
  isValidWalletDTO,
  isValidPaymentDTO,
  isValidDeliveryEventDTO,
  isValidNotificationPreferenceDTO,
  validateUserDTO,
  validateWalletDTO,
  validatePaymentDTO,
  filterPayments,
  extractAvailableAssets,
  isValidStellarPublicKey,
} from './index';

// Valid Ed25519 Stellar public key (genesis account)
const VALID_PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const VALID_TX_HASH = 'a'.repeat(64);

describe('@stellar-alerts/shared DTOs & validators (#571)', () => {
  describe('UserDTO validation', () => {
    it('accepts valid UserDTO objects with Date or ISO string timestamps', () => {
      const userWithIso: UserDTO = {
        id: 'usr_123',
        email: 'alice@example.com',
        createdAt: '2026-01-15T00:00:00.000Z',
        did: 'did:stellar:GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
      };
      expect(isValidUserDTO(userWithIso)).toBe(true);
      expect(validateUserDTO(userWithIso)).toEqual(userWithIso);

      const userWithDate: UserDTO = {
        id: 'usr_456',
        email: 'bob@example.com',
        createdAt: new Date('2026-01-15T00:00:00.000Z'),
      };
      expect(isValidUserDTO(userWithDate)).toBe(true);
    });

    it('rejects malformed UserDTO payloads', () => {
      expect(isValidUserDTO({ id: '', email: 'alice@example.com', createdAt: '2026-01-01' })).toBe(
        false,
      );
      expect(isValidUserDTO({ id: 'usr_1', email: 'not-an-email', createdAt: '2026-01-01' })).toBe(
        false,
      );
      expect(() =>
        validateUserDTO({ id: 'usr_1', email: 'invalid', createdAt: '' }),
      ).toThrow();
    });
  });

  describe('WalletDTO validation', () => {
    it('accepts valid WalletDTO objects and verifies Ed25519 publicKey checksum', () => {
      const wallet: WalletDTO = {
        id: 'wal_123',
        userId: 'usr_123',
        publicKey: VALID_PUBLIC_KEY,
        label: 'Treasury Wallet',
        createdAt: '2026-01-15T00:00:00.000Z',
      };
      expect(isValidWalletDTO(wallet)).toBe(true);
      expect(validateWalletDTO(wallet)).toEqual(wallet);
    });

    it('rejects WalletDTO with corrupted Stellar publicKey checksum', () => {
      const corruptedKey = VALID_PUBLIC_KEY.slice(0, -1) + 'A';
      expect(
        isValidWalletDTO({
          id: 'wal_123',
          userId: 'usr_123',
          publicKey: corruptedKey,
          createdAt: '2026-01-15T00:00:00.000Z',
        }),
      ).toBe(false);
    });
  });

  describe('PaymentDTO validation', () => {
    it('accepts valid PaymentDTO objects with numeric or decimal string amounts and optional pagingToken', () => {
      const payment: PaymentDTO = {
        id: 'pay_123',
        walletId: 'wal_123',
        txHash: VALID_TX_HASH,
        fromAddress: VALID_PUBLIC_KEY,
        amount: '125.5000000',
        asset: 'XLM',
        memo: 'invoice-42',
        receivedAt: '2026-01-15T00:00:00.000Z',
        pagingToken: '987654321',
      };
      expect(isValidPaymentDTO(payment)).toBe(true);
      expect(validatePaymentDTO(payment)).toEqual(payment);
    });

    it('rejects PaymentDTO with invalid txHash or negative amount', () => {
      expect(
        isValidPaymentDTO({
          id: 'pay_1',
          walletId: 'wal_1',
          txHash: 'not-a-valid-tx-hash',
          fromAddress: VALID_PUBLIC_KEY,
          amount: 10,
          asset: 'XLM',
          receivedAt: '2026-01-15T00:00:00.000Z',
        }),
      ).toBe(false);

      expect(
        isValidPaymentDTO({
          id: 'pay_1',
          walletId: 'wal_1',
          txHash: VALID_TX_HASH,
          fromAddress: VALID_PUBLIC_KEY,
          amount: -5,
          asset: 'XLM',
          receivedAt: '2026-01-15T00:00:00.000Z',
        }),
      ).toBe(false);
    });
  });

  describe('DeliveryEventDTO, NotificationPreferenceDTO, and WebhookDTO schemas', () => {
    it('validates DeliveryEventDTO and NotificationPreferenceDTO', () => {
      const delivery: DeliveryEventDTO = {
        id: 'del_1',
        webhookId: 'wh_1',
        statusCode: 200,
        responseBody: '{"ok":true}',
        error: null,
        sentAt: '2026-01-15T00:00:00.000Z',
      };
      expect(isValidDeliveryEventDTO(delivery)).toBe(true);
      expect(deliveryEventDtoSchema.parse(delivery)).toEqual(delivery);

      const prefs: NotificationPreferenceDTO = {
        id: 'pref_1',
        userId: 'usr_1',
        telegramChatId: '123456',
        telegramEnabled: true,
        emailEnabled: false,
        whatsappNumber: null,
        whatsappEnabled: false,
      };
      expect(isValidNotificationPreferenceDTO(prefs)).toBe(true);
      expect(notificationPreferenceDtoSchema.parse(prefs)).toEqual(prefs);

      const webhook = {
        id: 'wh_1',
        userId: 'usr_1',
        url: 'https://example.com/webhooks/stellar',
        createdAt: '2026-01-15T00:00:00.000Z',
      };
      expect(webhookDtoSchema.safeParse(webhook).success).toBe(true);
    });
  });

  describe('Shared request DTO schemas and payment helpers', () => {
    it('validates auth and wallet request DTOs', () => {
      expect(requestLinkDtoSchema.safeParse({ email: 'user@example.com' }).success).toBe(true);
      expect(verifyLinkDtoSchema.safeParse({ token: 'jwt-token' }).success).toBe(true);
      expect(didChallengeDtoSchema.safeParse({ did: `did:stellar:${VALID_PUBLIC_KEY}` }).success).toBe(
        true,
      );
      expect(
        didVerifyDtoSchema.safeParse({
          did: `did:stellar:${VALID_PUBLIC_KEY}`,
          challenge: 'challenge-payload',
          signature: 'base64-sig',
        }).success,
      ).toBe(true);
      expect(
        createWalletDtoSchema.safeParse({
          publicKey: VALID_PUBLIC_KEY,
          label: 'Hot Wallet',
        }).success,
      ).toBe(true);
      expect(isValidStellarPublicKey(VALID_PUBLIC_KEY)).toBe(true);
    });

    it('filters payments and extracts available assets', () => {
      const samplePayments: PaymentDTO[] = [
        {
          id: 'p1',
          walletId: 'w1',
          txHash: VALID_TX_HASH,
          fromAddress: VALID_PUBLIC_KEY,
          amount: '50',
          asset: 'XLM',
          memo: 'donation',
          receivedAt: '2026-01-15T00:00:00.000Z',
        },
        {
          id: 'p2',
          walletId: 'w1',
          txHash: 'b'.repeat(64),
          fromAddress: VALID_PUBLIC_KEY,
          amount: '100',
          asset: 'USDC',
          memo: 'payroll',
          receivedAt: '2026-01-15T01:00:00.000Z',
        },
      ];

      expect(extractAvailableAssets(samplePayments)).toEqual(['ALL', 'USDC', 'XLM']);
      expect(filterPayments(samplePayments, 'payroll', 'ALL')).toHaveLength(1);
      expect(filterPayments(samplePayments, '', 'XLM')).toHaveLength(1);
    });
  });
});
