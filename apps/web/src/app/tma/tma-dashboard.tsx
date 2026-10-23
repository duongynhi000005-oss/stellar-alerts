'use client';

import { useState } from 'react';
import type { WalletDTO } from '@stellar-alerts/shared';
import { shortKey, type TmaAuthResult } from './tma.helpers';
import * as haptics from './haptics';
import AlertTriagePanel from './alert-triage';

export interface RecentPayment {
  id: string;
  amount: string;
  asset: string;
  receivedAt: string;
}

export interface TMADashboardProps {
  session: TmaAuthResult;
  wallets: WalletDTO[];
  recentPayments: RecentPayment[];
  initData?: string | null;
  apiBase?: string;
  telegramAlerts: boolean;
  onToggleTelegramAlerts: () => void | Promise<void>;
  sorobanAlerts?: boolean;
  onToggleSorobanAlerts?: () => void | Promise<void>;
  whaleAlerts?: boolean;
  onToggleWhaleAlerts?: () => void | Promise<void>;
  onRemoveWallet: (id: string) => void | Promise<void>;
  onAddWallet: (e: React.FormEvent) => void | Promise<void>;
  newKey: string;
  setNewKey: (key: string) => void;
  formError: string | null;
  busy: boolean;
}

/**
 * Mobile-optimized Telegram Mini App (TMA) Wallet Alert Dashboard (#734).
 *
 * Implements Telegram client theme parameters, toggling alert rules with
 * native haptic feedback, and viewing live recent payment pushes.
 */
export function TMADashboard({
  session,
  wallets,
  recentPayments,
  initData,
  apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
  telegramAlerts,
  onToggleTelegramAlerts,
  sorobanAlerts = false,
  onToggleSorobanAlerts,
  whaleAlerts = false,
  onToggleWhaleAlerts,
  onRemoveWallet,
  onAddWallet,
  newKey,
  setNewKey,
  formError,
  busy,
}: TMADashboardProps) {
  const [internalSoroban, setInternalSoroban] = useState(sorobanAlerts);
  const [internalWhale, setInternalWhale] = useState(whaleAlerts);

  const handleTogglePush = async () => {
    haptics.selection();
    try {
      await onToggleTelegramAlerts();
      haptics.impact('light');
    } catch {
      haptics.notify('error');
    }
  };

  const handleToggleSoroban = async () => {
    haptics.selection();
    const next = !internalSoroban;
    setInternalSoroban(next);
    if (onToggleSorobanAlerts) {
      try {
        await onToggleSorobanAlerts();
        haptics.impact('light');
      } catch {
        haptics.notify('error');
      }
    }
  };

  const handleToggleWhale = async () => {
    haptics.selection();
    const next = !internalWhale;
    setInternalWhale(next);
    if (onToggleWhaleAlerts) {
      try {
        await onToggleWhaleAlerts();
        haptics.impact('light');
      } catch {
        haptics.notify('error');
      }
    }
  };

  const handleRemove = async (id: string) => {
    haptics.impact('medium');
    await onRemoveWallet(id);
  };

  return (
    <main
      className="flex flex-col gap-5 text-slate-100"
      data-testid="tma-dashboard"
      style={{
        backgroundColor: 'var(--tg-theme-bg-color, transparent)',
        color: 'var(--tg-theme-text-color, #f1f5f9)',
      }}
    >
      {/* Push Feed & Live Alerts */}
      <section
        className="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 flex flex-col gap-3 shadow-sm"
        style={{
          backgroundColor: 'var(--tg-theme-secondary-bg-color, rgba(15, 23, 42, 0.7))',
          borderColor: 'var(--tg-theme-section-separator-color, #1e293b)',
        }}
        aria-labelledby="tma-push-feed-title"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="tma-push-feed-title" className="text-sm font-semibold">
              Recent payment pushes
            </h2>
            <p
              className="text-xs text-slate-400"
              style={{ color: 'var(--tg-theme-hint-color, #94a3b8)' }}
            >
              Live alert preview from your watched wallets.
            </p>
          </div>
        </div>
        {recentPayments.length === 0 ? (
          <p
            className="text-xs text-slate-500 py-1"
            style={{ color: 'var(--tg-theme-hint-color, #64748b)' }}
          >
            No recent payments yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {recentPayments.map((payment) => (
              <li
                key={payment.id}
                onClick={() => haptics.selection()}
                className="rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2 flex items-center justify-between gap-2 text-xs active:scale-[0.99] transition-transform cursor-pointer"
                style={{
                  backgroundColor: 'var(--tg-theme-bg-color, rgba(2, 6, 23, 0.6))',
                  borderColor: 'var(--tg-theme-section-separator-color, #1e293b)',
                }}
              >
                <span className="font-mono text-emerald-400 font-medium">
                  +{payment.amount} {payment.asset}
                </span>
                <time
                  className="text-slate-400"
                  style={{ color: 'var(--tg-theme-hint-color, #94a3b8)' }}
                  dateTime={payment.receivedAt}
                >
                  {new Date(payment.receivedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Alert Rules & Toggles */}
      <section
        className="rounded-2xl bg-slate-900/70 border border-slate-800 p-4 flex flex-col gap-3"
        style={{
          backgroundColor: 'var(--tg-theme-secondary-bg-color, rgba(15, 23, 42, 0.7))',
          borderColor: 'var(--tg-theme-section-separator-color, #1e293b)',
        }}
        aria-labelledby="tma-rules-title"
      >
        <h2 id="tma-rules-title" className="text-sm font-semibold">
          Alert Rules & Subscriptions
        </h2>

        {/* Telegram Notifications Toggle */}
        <div className="flex items-center justify-between gap-3 py-1">
          <div>
            <p className="text-sm font-medium">Telegram notifications</p>
            <p
              className="text-xs text-slate-400"
              style={{ color: 'var(--tg-theme-hint-color, #94a3b8)' }}
            >
              Ping this chat on every incoming payment.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={telegramAlerts}
            aria-label="Toggle Telegram notifications"
            onClick={handleTogglePush}
            className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${
              telegramAlerts ? 'bg-cyan-500' : 'bg-slate-700'
            }`}
            style={{
              backgroundColor: telegramAlerts
                ? 'var(--tg-theme-button-color, #06b6d4)'
                : undefined,
            }}
          >
            <span
              className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform ${
                telegramAlerts ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Soroban Contract Events Toggle */}
        <div className="flex items-center justify-between gap-3 py-1 border-t border-slate-800/60 pt-2">
          <div>
            <p className="text-sm font-medium">Soroban contract events</p>
            <p
              className="text-xs text-slate-400"
              style={{ color: 'var(--tg-theme-hint-color, #94a3b8)' }}
            >
              Alert on smart contract invocations and SAC events.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={internalSoroban}
            aria-label="Toggle Soroban contract events"
            onClick={handleToggleSoroban}
            className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${
              internalSoroban ? 'bg-cyan-500' : 'bg-slate-700'
            }`}
            style={{
              backgroundColor: internalSoroban
                ? 'var(--tg-theme-button-color, #06b6d4)'
                : undefined,
            }}
          >
            <span
              className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform ${
                internalSoroban ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Whale Transfer Alerts Toggle */}
        <div className="flex items-center justify-between gap-3 py-1 border-t border-slate-800/60 pt-2">
          <div>
            <p className="text-sm font-medium">Whale transaction filter</p>
            <p
              className="text-xs text-slate-400"
              style={{ color: 'var(--tg-theme-hint-color, #94a3b8)' }}
            >
              Prioritize transfers exceeding volumetric threshold.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={internalWhale}
            aria-label="Toggle Whale transaction filter"
            onClick={handleToggleWhale}
            className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${
              internalWhale ? 'bg-cyan-500' : 'bg-slate-700'
            }`}
            style={{
              backgroundColor: internalWhale
                ? 'var(--tg-theme-button-color, #06b6d4)'
                : undefined,
            }}
          >
            <span
              className={`absolute top-1 w-5 h-5 rounded-full bg-white transition-transform ${
                internalWhale ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </section>

      {/* Alert Triage & Thresholds Panel */}
      {initData && <AlertTriagePanel apiBase={apiBase} initData={initData} />}

      {/* Watched Wallets Section */}
      <section className="flex flex-col gap-3">
        <h2
          className="text-sm font-semibold text-slate-300"
          style={{ color: 'var(--tg-theme-section-header-text-color, #cbd5e1)' }}
        >
          Watched wallets ({wallets.length})
        </h2>

        {wallets.length === 0 ? (
          <p
            className="text-xs text-slate-500 rounded-2xl bg-slate-900/50 border border-slate-800 p-4"
            style={{
              backgroundColor: 'var(--tg-theme-secondary-bg-color, rgba(15, 23, 42, 0.5))',
              borderColor: 'var(--tg-theme-section-separator-color, #1e293b)',
              color: 'var(--tg-theme-hint-color, #64748b)',
            }}
          >
            No wallets yet. Add a Stellar public key below to start receiving alerts.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {wallets.map((wallet) => (
              <li
                key={wallet.id}
                className="rounded-2xl bg-slate-900/70 border border-slate-800 p-3 flex items-center justify-between gap-3"
                style={{
                  backgroundColor: 'var(--tg-theme-secondary-bg-color, rgba(15, 23, 42, 0.7))',
                  borderColor: 'var(--tg-theme-section-separator-color, #1e293b)',
                }}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {wallet.label || 'Stellar wallet'}
                  </p>
                  <p
                    className="text-xs font-mono text-slate-400"
                    style={{ color: 'var(--tg-theme-hint-color, #94a3b8)' }}
                  >
                    {shortKey(wallet.publicKey)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(wallet.id)}
                  disabled={busy}
                  aria-label={`Remove wallet ${shortKey(wallet.publicKey)}`}
                  className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 text-red-300 border border-red-500/30 active:bg-red-500/20 disabled:opacity-40"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Add Wallet Form */}
      <form onSubmit={onAddWallet} className="flex flex-col gap-2">
        <label
          htmlFor="tma-wallet-key"
          className="text-sm font-semibold text-slate-300"
          style={{ color: 'var(--tg-theme-section-header-text-color, #cbd5e1)' }}
        >
          Add a wallet
        </label>
        <input
          id="tma-wallet-key"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="G…"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="w-full px-4 py-3 rounded-xl bg-slate-950 border border-slate-800 text-sm font-mono text-slate-100 placeholder-slate-600 focus:outline-none focus:border-cyan-500"
          style={{
            backgroundColor: 'var(--tg-theme-bg-color, #020617)',
            borderColor: 'var(--tg-theme-section-separator-color, #1e293b)',
            color: 'var(--tg-theme-text-color, #f1f5f9)',
          }}
        />
        {formError && (
          <p className="text-xs text-red-400" role="alert">
            {formError}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-white font-semibold text-sm disabled:opacity-50 active:scale-[0.99] transition-transform"
          style={{
            backgroundColor: 'var(--tg-theme-button-color, #06b6d4)',
            color: 'var(--tg-theme-button-text-color, #ffffff)',
          }}
        >
          {busy ? 'Working…' : 'Add wallet'}
        </button>
      </form>
    </main>
  );
}

export default TMADashboard;
