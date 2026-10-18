import { z } from 'zod';
import { isValidEd25519PublicKey, isValidTransactionHash } from './strkey';

// Generated from the API's OpenAPI schema — see scripts/generate-types.ts.
// Re-exported under a `Api` namespace to avoid clashing with the
// hand-written DTOs below (`components["schemas"]["RequestLinkInput"]`, etc).
export type { components as ApiComponents, paths as ApiPaths } from './generated/api-types';
export * from './config/index';
export * from './merkle';
// Single source of truth for Stellar StrKey / transaction-hash validation
// (Ed25519 public keys, contract IDs, muxed addresses, transaction hashes).
export * from './strkey';

export interface UserDTO {
  id: string;
  email: string;
  createdAt: Date | string;
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

export const UserDTOSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  createdAt: z.union([z.date(), z.string().min(1)]),
});

export const WalletDTOSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  publicKey: z.string().refine(isValidEd25519PublicKey, {
    message: 'Invalid Stellar Ed25519 public key',
  }),
  label: z.string().nullable().optional(),
  createdAt: z.union([z.date(), z.string().min(1)]),
});

export const PaymentDTOSchema = z.object({
  id: z.string().min(1),
  walletId: z.string().min(1),
  txHash: z.string().refine(isValidTransactionHash, {
    message: 'Invalid Stellar transaction hash',
  }),
  fromAddress: z.string().min(1),
  amount: z.union([z.number().nonnegative(), z.string().min(1)]),
  asset: z.string().min(1),
  memo: z.string().nullable().optional(),
  receivedAt: z.union([z.date(), z.string().min(1)]),
});

export function isValidUserDTO(candidate: unknown): candidate is UserDTO {
  return UserDTOSchema.safeParse(candidate).success;
}

export function isValidWalletDTO(candidate: unknown): candidate is WalletDTO {
  return WalletDTOSchema.safeParse(candidate).success;
}

export function isValidPaymentDTO(candidate: unknown): candidate is PaymentDTO {
  return PaymentDTOSchema.safeParse(candidate).success;
}

/**
 * Validates whether a given string is a valid Stellar Ed25519 Public Key.
 *
 * Backwards-compatible name for {@link isValidEd25519PublicKey}; it now
 * performs full StrKey validation (version byte + CRC16-XMODEM checksum)
 * through the shared `strkey` module instead of the previous shape-only check
 * (`length === 56 && startsWith('G')`) that accepted corrupted keys.
 */
export function isValidStellarPublicKey(publicKey: string): boolean {
  return isValidEd25519PublicKey(publicKey);
}

/**
 * Filters a list of payments by search query (address, txHash, asset, memo) and asset code.
 */
export function filterPayments<T extends PaymentDTO>(
  payments: T[],
  searchQuery: string,
  selectedAsset: string = 'ALL'
): T[] {
  const query = searchQuery.trim().toLowerCase();
  return payments.filter((payment) => {
    const matchesQuery =
      !query ||
      (payment.fromAddress && payment.fromAddress.toLowerCase().includes(query)) ||
      (payment.txHash && payment.txHash.toLowerCase().includes(query)) ||
      (payment.asset && payment.asset.toLowerCase().includes(query)) ||
      (payment.memo && payment.memo.toLowerCase().includes(query));

    const matchesAsset =
      selectedAsset === 'ALL' ||
      (payment.asset && payment.asset.toUpperCase() === selectedAsset.toUpperCase());

    return matchesQuery && matchesAsset;
  });
}

/**
 * Extracts unique asset codes from a payments list with 'ALL' as the first default option.
 */
export function extractAvailableAssets(payments: PaymentDTO[]): string[] {
  const assets = new Set<string>();
  payments.forEach((p) => {
    if (p.asset) {
      assets.add(p.asset.toUpperCase());
    }
  });
  return ['ALL', ...Array.from(assets).sort()];
}


