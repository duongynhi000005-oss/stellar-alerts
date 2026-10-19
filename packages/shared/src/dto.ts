import { z } from 'zod';
import { isValidEd25519PublicKey, isValidTransactionHash } from './strkey';

/**
 * Shared Data Transfer Objects (DTOs) and Zod runtime validators across
 * `apps/api`, `apps/web`, and `packages/cli` (#571).
 */

export interface UserDTO {
  id: string;
  email: string;
  createdAt: Date | string;
  did?: string | null;
}

export interface WalletDTO {
  id: string;
  userId: string;
  publicKey: string;
  label?: string | null;
  createdAt: Date | string;
}

export interface PaymentDTO {
  id: string;
  walletId: string;
  txHash: string;
  fromAddress: string;
  amount: number | string;
  asset: string;
  memo?: string | null;
  receivedAt: Date | string;
  /** Resume token for `/payments/stream?cursor=`; falls back to `id` when absent. */
  pagingToken?: string;
}

export interface DeliveryEventDTO {
  id: string;
  webhookId: string;
  statusCode?: number | null;
  responseBody?: string | null;
  error?: string | null;
  sentAt: Date | string;
}

export interface NotificationPreferenceDTO {
  id: string;
  userId: string;
  telegramChatId?: string | null;
  telegramEnabled: boolean;
  emailEnabled: boolean;
  whatsappNumber?: string | null;
  whatsappEnabled: boolean;
}

export interface WebhookDTO {
  id: string;
  userId: string;
  url: string;
  secret?: string;
  payloadTemplate?: string | null;
  createdAt: Date | string;
}

export type PaymentSortField = 'receivedAt' | 'amount' | 'asset';
export type SortOrder = 'asc' | 'desc';

export interface GetPaymentsFiltersDTO {
  walletId?: string;
  asset?: string;
  memo?: string;
  dateFrom?: string | Date;
  dateTo?: string | Date;
  sortBy?: PaymentSortField;
  sortOrder?: SortOrder;
  cursor?: string;
}

export interface PaymentsSummaryDTO {
  totalVolumeXLM: number | string;
  totalPayments: number;
  fiatValue?: number;
  fiatCurrency?: string;
}

const isoOrDateSchema = z.union([
  z.date(),
  z.string().min(1, 'Timestamp string must not be empty'),
]);

export const userDtoSchema = z.object({
  id: z.string().min(1, 'User ID is required'),
  email: z.string().email('Invalid email address'),
  createdAt: isoOrDateSchema,
  did: z.string().min(1).nullable().optional(),
});

export const walletDtoSchema = z.object({
  id: z.string().min(1, 'Wallet ID is required'),
  userId: z.string().min(1, 'User ID is required'),
  publicKey: z.string().refine((val) => isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public key format or checksum',
  }),
  label: z.string().nullable().optional(),
  createdAt: isoOrDateSchema,
});

export const paymentDtoSchema = z.object({
  id: z.string().min(1, 'Payment ID is required'),
  walletId: z.string().min(1, 'Wallet ID is required'),
  txHash: z.string().refine((val) => isValidTransactionHash(val), {
    message: 'Invalid Stellar transaction hash (expected 64-character hex string)',
  }),
  fromAddress: z.string().min(1, 'Sender address is required'),
  amount: z.union([
    z.number().nonnegative('Amount must be non-negative'),
    z.string().regex(/^\d+(\.\d+)?$/, 'Amount string must be a valid non-negative decimal'),
  ]),
  asset: z.string().min(1, 'Asset code is required'),
  memo: z.string().nullable().optional(),
  receivedAt: isoOrDateSchema,
  pagingToken: z.string().min(1).optional(),
});

export const deliveryEventDtoSchema = z.object({
  id: z.string().min(1, 'Delivery event ID is required'),
  webhookId: z.string().min(1, 'Webhook ID is required'),
  statusCode: z.number().int().nullable().optional(),
  responseBody: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  sentAt: isoOrDateSchema,
});

export const notificationPreferenceDtoSchema = z.object({
  id: z.string().min(1, 'Notification preference ID is required'),
  userId: z.string().min(1, 'User ID is required'),
  telegramChatId: z.string().nullable().optional(),
  telegramEnabled: z.boolean(),
  emailEnabled: z.boolean(),
  whatsappNumber: z.string().nullable().optional(),
  whatsappEnabled: z.boolean(),
});

export const webhookDtoSchema = z.object({
  id: z.string().min(1, 'Webhook ID is required'),
  userId: z.string().min(1, 'User ID is required'),
  url: z.string().url().max(2048),
  secret: z.string().min(1).optional(),
  payloadTemplate: z.string().max(16384).nullable().optional(),
  createdAt: isoOrDateSchema,
});

/**
 * Shared authentication & wallet request DTO schemas used by both API and Web.
 */
export const requestLinkDtoSchema = z.object({
  email: z.string().email(),
});

export const verifyLinkDtoSchema = z.object({
  token: z.string().min(1),
});

export const didChallengeDtoSchema = z.object({
  did: z.string().min(1).max(2048),
});

export const didVerifyDtoSchema = z.object({
  did: z.string().min(1).max(2048),
  challenge: z.string().min(1).max(4096),
  signature: z.string().min(1).max(8192),
});

export const createWalletDtoSchema = z.object({
  publicKey: z.string().refine((val) => isValidEd25519PublicKey(val), {
    message: 'Invalid Stellar public key format or checksum',
  }),
  label: z.string().optional(),
});

export type RequestLinkDto = z.infer<typeof requestLinkDtoSchema>;
export type VerifyLinkDto = z.infer<typeof verifyLinkDtoSchema>;
export type DIDChallengeDto = z.infer<typeof didChallengeDtoSchema>;
export type DIDVerifyDto = z.infer<typeof didVerifyDtoSchema>;
export type CreateWalletDto = z.infer<typeof createWalletDtoSchema>;

/**
 * Type guard and runtime validation helpers for shared DTOs.
 */
export function isValidUserDTO(value: unknown): value is UserDTO {
  return userDtoSchema.safeParse(value).success;
}

export function isValidWalletDTO(value: unknown): value is WalletDTO {
  return walletDtoSchema.safeParse(value).success;
}

export function isValidPaymentDTO(value: unknown): value is PaymentDTO {
  return paymentDtoSchema.safeParse(value).success;
}

export function isValidDeliveryEventDTO(value: unknown): value is DeliveryEventDTO {
  return deliveryEventDtoSchema.safeParse(value).success;
}

export function isValidNotificationPreferenceDTO(
  value: unknown,
): value is NotificationPreferenceDTO {
  return notificationPreferenceDtoSchema.safeParse(value).success;
}

export function validateUserDTO(value: unknown): UserDTO {
  return userDtoSchema.parse(value);
}

export function validateWalletDTO(value: unknown): WalletDTO {
  return walletDtoSchema.parse(value);
}

export function validatePaymentDTO(value: unknown): PaymentDTO {
  return paymentDtoSchema.parse(value);
}
