import React, { useState, useEffect, useMemo } from 'react';
import {
  createSignatureChallenge,
  requestWalletSignature,
  SignedMutationProof,
  WalletProviderType,
  WalletSignerFn,
  MutationActionType,
} from '../../lib/wallet/signature-guard';

export interface WalletAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (proof: SignedMutationProof) => void | Promise<void>;
  onError?: (error: Error) => void;
  publicKey: string;
  action?: MutationActionType | string;
  actionLabel?: string;
  payload: unknown;
  defaultProvider?: WalletProviderType;
  timestamp?: number;
  signer?: WalletSignerFn;
  verifyCryptographically?: boolean;
}

const DEFAULT_FALLBACK_PUBLIC_KEY =
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export const WalletAuthModal: React.FC<WalletAuthModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  onError,
  publicKey,
  action = 'RULE_MUTATION',
  actionLabel = 'Modify Alert Rule Configuration',
  payload,
  defaultProvider = 'freighter',
  timestamp,
  signer,
  verifyCryptographically = false,
}) => {
  const effectivePublicKey = publicKey?.trim() || DEFAULT_FALLBACK_PUBLIC_KEY;
  const [provider, setProvider] = useState<WalletProviderType>(defaultProvider);
  const [isSigning, setIsSigning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const challengeObj = useMemo(() => {
    try {
      return createSignatureChallenge({
        action,
        payload,
        publicKey: effectivePublicKey,
        timestamp,
      });
    } catch {
      return createSignatureChallenge({
        action,
        payload,
        publicKey: DEFAULT_FALLBACK_PUBLIC_KEY,
        timestamp,
      });
    }
  }, [action, payload, effectivePublicKey, timestamp]);

  useEffect(() => {
    if (!isOpen) {
      setIsSigning(false);
      setErrorMessage(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSigning) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSigning, onClose]);

  if (!isOpen) return null;

  const handleSign = async () => {
    setIsSigning(true);
    setErrorMessage(null);

    try {
      const proof = await requestWalletSignature({
        action,
        payload,
        publicKey: challengeObj.publicKey,
        provider: signer ? 'custom' : provider,
        challengeOverride: challengeObj,
        signer,
        verifyCryptographically,
      });
      await onSuccess(proof);
    } catch (err) {
      const error =
        err instanceof Error
          ? err
          : new Error('Signature request was rejected or failed.');
      setErrorMessage(error.message);
      onError?.(error);
    } finally {
      setIsSigning(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-auth-modal-title"
      data-testid="wallet-auth-modal"
    >
      <div className="w-full max-w-lg rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3
              id="wallet-auth-modal-title"
              className="text-lg font-bold text-white flex items-center gap-2"
            >
              <span>🔐</span> Non-Custodial Wallet Signature Required
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Sign this timestamped challenge with your Stellar wallet to authorize:{' '}
              <span className="text-purple-400 font-semibold">{actionLabel}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSigning}
            aria-label="Close Wallet Authentication Modal"
            className="text-slate-400 hover:text-white transition-colors disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {/* Provider Selector */}
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Select Wallet Signer
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(['freighter', 'albedo'] as WalletProviderType[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setProvider(item)}
                aria-pressed={provider === item}
                data-testid={`provider-${item}`}
                className={`px-3 py-2 rounded-xl border text-xs font-semibold capitalize transition-all ${
                  provider === item
                    ? 'bg-purple-600/20 border-purple-500 text-purple-300'
                    : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
              >
                {item === 'freighter' ? '🚀 Freighter' : '🌌 Albedo'}
              </button>
            ))}
          </div>
        </div>

        {/* Challenge Details */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="font-semibold uppercase tracking-wider">Challenge Payload</span>
            <span className="font-mono text-[11px] text-cyan-400">
              {challengeObj.publicKey.slice(0, 8)}...{challengeObj.publicKey.slice(-6)}
            </span>
          </div>
          <pre
            data-testid="challenge-preview"
            className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300 overflow-x-auto whitespace-pre-wrap max-h-40"
          >
            {challengeObj.challenge}
          </pre>
        </div>

        {errorMessage && (
          <div
            role="alert"
            data-testid="wallet-auth-error"
            className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300"
          >
            {errorMessage}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSigning}
            className="px-4 py-2 rounded-xl border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 text-xs font-semibold transition-colors disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSign}
            disabled={isSigning}
            data-testid="confirm-wallet-signature-btn"
            className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition-all shadow-lg shadow-purple-600/20 disabled:opacity-50"
          >
            {isSigning ? 'Waiting for Wallet Signature...' : 'Sign & Authorize'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default WalletAuthModal;
