import React from 'react';
import { WalletDTO } from '@stellar-alerts/shared';
import { CopyButton } from '../ui/CopyButton';

export interface WalletCardProps {
  wallet: WalletDTO;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

export const WalletCard: React.FC<WalletCardProps> = ({
  wallet,
  isSelected,
  onSelect,
  onRemove,
}) => {
  const truncatedKey =
    wallet.publicKey.length > 16
      ? `${wallet.publicKey.substring(0, 8)}...${wallet.publicKey.substring(wallet.publicKey.length - 8)}`
      : wallet.publicKey;

  return (
    <div
      onClick={() => onSelect(wallet.id)}
      className={`p-4 rounded-xl border cursor-pointer transition-all duration-200 flex items-center justify-between group ${
        isSelected
          ? 'bg-purple-950/30 border-purple-500/50 shadow-md shadow-purple-500/10'
          : 'bg-slate-950/30 border-slate-800/60 hover:border-slate-700'
      }`}
    >
      <div className="truncate pr-2 flex-1 min-w-0">
        <div className="font-semibold text-sm text-white truncate">
          {wallet.label || 'Unnamed Wallet'}
        </div>
        <div className="text-xs text-slate-400 font-mono mt-1 flex items-center gap-2">
          <span className="truncate" title={wallet.publicKey}>
            {truncatedKey}
          </span>
          <CopyButton
            value={wallet.publicKey}
            label={`Copy wallet public key ${wallet.publicKey}`}
          />
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(wallet.id);
        }}
        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors opacity-0 group-hover:opacity-100"
        title="Remove wallet"
      >
        🗑️
      </button>
    </div>
  );
};
