'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WalletDTO } from '@stellar-alerts/shared';
import { isValidStellarPublicKey } from '@stellar-alerts/shared';
import { getRawInitData, signalReady } from './telegram-client';
import { parseTelegramAuthResponse, shortKey, type TmaAuthResult } from './tma.helpers';
import TMADashboard, { type RecentPayment } from './tma-dashboard';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

type Phase = 'authenticating' | 'error' | 'ready';

export default function TelegramMiniApp() {
  const [phase, setPhase] = useState<Phase>('authenticating');
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<TmaAuthResult | null>(null);

  const [wallets, setWallets] = useState<WalletDTO[]>([]);
  const [newKey, setNewKey] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [telegramAlerts, setTelegramAlerts] = useState(true);
  const [recentPayments, setRecentPayments] = useState<RecentPayment[]>([]);
  const [initData, setInitData] = useState<string | null>(null);

  const authHeaders = useCallback(
    (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` }),
    [],
  );

  const loadWallets = useCallback(
    async (token: string) => {
      try {
        const res = await fetch(`${API_BASE}/wallets`, { headers: authHeaders(token) });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.success && Array.isArray(body.wallets)) {
          setWallets(body.wallets);
        }
      } catch {
        /* keep whatever list we already have */
      }
    },
    [authHeaders],
  );

  const loadRecentPayments = useCallback(
    async (token: string) => {
      try {
        const res = await fetch(`${API_BASE}/payments?limit=5`, { headers: authHeaders(token) });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.success && Array.isArray(body.payments)) {
          setRecentPayments(
            body.payments.map((payment: Record<string, unknown>) => ({
              id: String(payment.id),
              amount: String(payment.amount),
              asset: String(payment.asset),
              receivedAt: String(payment.receivedAt),
            })),
          );
        }
      } catch {
        /* push feed is best-effort */
      }
    },
    [authHeaders],
  );

  // Authenticate against the Telegram init-data flow as soon as the app mounts.
  useEffect(() => {
    let cancelled = false;
    signalReady();

    (async () => {
      const initData = getRawInitData();
      if (!initData) {
        if (!cancelled) {
          setError('Open this page from inside Telegram to manage your wallet alerts.');
          setPhase('error');
        }
        return;
      }
      if (!cancelled) setInitData(initData);

      try {
        const res = await fetch(`${API_BASE}/auth/telegram`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
        const body = await res.json().catch(() => ({}));
        const result = parseTelegramAuthResponse(res.status, body);
        if (cancelled) return;
        setSession(result);
        setPhase('ready');
        await Promise.all([loadWallets(result.token), loadRecentPayments(result.token)]);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Telegram sign-in failed.');
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadRecentPayments, loadWallets]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.style.setProperty('color-scheme', 'dark');
  }, []);

  const handleAddWallet = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!session) return;
    const publicKey = newKey.trim();
    if (!isValidStellarPublicKey(publicKey)) {
      setFormError('Enter a valid Stellar public key (starts with G, 56 characters).');
      return;
    }
    setFormError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/wallets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(session.token) },
        body: JSON.stringify({ publicKey }),
      });
      if (res.ok) {
        setNewKey('');
        await loadWallets(session.token);
      } else {
        const body = await res.json().catch(() => ({}));
        setFormError(body.error || body.message || 'Could not add that wallet.');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveWallet = async (id: string) => {
    if (!session) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/wallets/${id}`, {
        method: 'DELETE',
        headers: authHeaders(session.token),
      });
      if (res.ok) setWallets((prev) => prev.filter((w) => w.id !== id));
    } finally {
      setBusy(false);
    }
  };

  const handleToggleTelegramAlerts = async () => {
    if (!session) return;
    const next = !telegramAlerts;
    setTelegramAlerts(next);
    try {
      await fetch(`${API_BASE}/notifications/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(session.token) },
        body: JSON.stringify({ telegramEnabled: next }),
      });
    } catch {
      /* optimistic: leave the toggle where the user put it */
    }
  };

  return (
    <div
      className="min-h-[var(--tg-viewport-height,100dvh)] w-full max-w-lg mx-auto bg-[#0b0b12] text-slate-100 px-4 py-5 flex flex-col gap-5"
      data-testid="tma-shell"
    >
      <header className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 flex items-center justify-center text-white text-sm font-bold">
          ⚡
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-bold leading-tight">Wallet Alerts</h1>
          <p className="text-xs text-slate-400 truncate">
            {session ? `Signed in as ${session.telegramName}` : 'Telegram Mini App'}
          </p>
        </div>
      </header>

      {phase === 'authenticating' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
          <div className="w-8 h-8 rounded-full border-2 border-slate-600 border-t-cyan-400 animate-spin" />
          <p className="text-sm" role="status">
            Verifying your Telegram session…
          </p>
        </div>
      )}

      {phase === 'error' && (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6"
          role="alert"
        >
          <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/30 flex items-center justify-center text-2xl">
            🚫
          </div>
          <p className="text-sm text-slate-300 max-w-xs">{error}</p>
        </div>
      )}

      {phase === 'ready' && session && (
        <TMADashboard
          session={session}
          wallets={wallets}
          recentPayments={recentPayments}
          initData={initData}
          apiBase={API_BASE}
          telegramAlerts={telegramAlerts}
          onToggleTelegramAlerts={handleToggleTelegramAlerts}
          onRemoveWallet={handleRemoveWallet}
          onAddWallet={handleAddWallet}
          newKey={newKey}
          setNewKey={setNewKey}
          formError={formError}
          busy={busy}
        />      )}
    </div>
  );
}
