'use client';

import React from 'react';

export interface QuickActionItem {
  id: string;
  step: string;
  title: string;
  description: string;
  badge: string;
  onSelect?: () => void;
}

export interface EmptyWatchersStateProps {
  onAddFirstWallet?: () => void;
  onOpenAddModal?: () => void;
  quickActions?: QuickActionItem[];
  title?: string;
  description?: string;
  ctaLabel?: string;
}

const DEFAULT_QUICK_ACTIONS: QuickActionItem[] = [
  {
    id: 'connect-wallet',
    step: '01',
    title: 'Connect a Stellar Address',
    description:
      'Register any Stellar Testnet or Mainnet public key (G-address) with zero private-key exposure.',
    badge: 'Read-Only Safe',
  },
  {
    id: 'configure-alerts',
    step: '02',
    title: 'Configure Real-Time Alerts',
    description:
      'Attach HMAC-signed webhook endpoints or custom email templates to receive sub-second ledger notifications.',
    badge: 'Instant Webhooks',
  },
  {
    id: 'stream-analytics',
    step: '03',
    title: 'Track Live Payment Flows',
    description:
      'Inspect incoming XLM and asset transfers, multi-hop path payments, and Soroban contract activity live.',
    badge: 'Horizon Stream',
  },
];

export const EmptyWatchersState: React.FC<EmptyWatchersStateProps> = ({
  onAddFirstWallet,
  onOpenAddModal,
  quickActions = DEFAULT_QUICK_ACTIONS,
  title = 'No Wallets Monitored Yet',
  description = 'Your real-time Stellar watcher service is active and ready. Add your first Stellar wallet address to stream incoming transactions, trigger instant webhook notifications, and unlock live ledger analytics.',
  ctaLabel = 'Add Your First Wallet',
}) => {
  const handlePrimaryAction = () => {
    const callback = onAddFirstWallet ?? onOpenAddModal;
    if (callback) {
      callback();
      return;
    }
    if (typeof document !== 'undefined') {
      const el = document.getElementById('add-wallet-section');
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  return (
    <section
      role="region"
      aria-labelledby="empty-watchers-heading"
      aria-describedby="empty-watchers-description"
      data-testid="empty-watchers-state"
      className="relative overflow-hidden rounded-3xl bg-slate-900/60 border border-cyan-500/20 backdrop-blur-xl p-8 md:p-10 shadow-2xl mb-8"
    >
      {/* Ambient glassmorphic glow accents */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -left-24 h-72 w-72 rounded-full bg-cyan-500/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 -right-24 h-72 w-72 rounded-full bg-purple-500/10 blur-3xl"
      />

      <div className="relative z-10 flex flex-col items-center text-center max-w-3xl mx-auto">
        {/* Status pill */}
        <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-semibold tracking-wide uppercase mb-6">
          <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse" aria-hidden="true" />
          Zero-Watcher Onboarding
        </div>

        {/* Friendly Onboarding SVG Illustration */}
        <div className="mb-6 flex items-center justify-center">
          <svg
            data-testid="empty-watchers-illustration"
            role="img"
            aria-label="Stellar wallet watcher onboarding illustration"
            viewBox="0 0 240 160"
            className="w-56 h-36 md:w-64 md:h-40 drop-shadow-[0_0_24px_rgba(34,211,238,0.2)]"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Stellar Real-Time Watcher Onboarding Illustration</title>
            <defs>
              <linearGradient id="stellarOrbitGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.85" />
                <stop offset="50%" stopColor="#818cf8" stopOpacity="0.65" />
                <stop offset="100%" stopColor="#c084fc" stopOpacity="0.85" />
              </linearGradient>
              <radialGradient id="stellarCoreGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.35" />
                <stop offset="70%" stopColor="#6366f1" stopOpacity="0.1" />
                <stop offset="100%" stopColor="#0f172a" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Outer glow field */}
            <circle cx="120" cy="80" r="72" fill="url(#stellarCoreGlow)" />

            {/* Orbital rings */}
            <ellipse
              cx="120"
              cy="80"
              rx="86"
              ry="36"
              transform="rotate(-14 120 80)"
              stroke="url(#stellarOrbitGrad)"
              strokeWidth="1.5"
              strokeDasharray="6 6"
              opacity="0.7"
            />
            <ellipse
              cx="120"
              cy="80"
              rx="64"
              ry="26"
              transform="rotate(18 120 80)"
              stroke="url(#stellarOrbitGrad)"
              strokeWidth="1.25"
              opacity="0.45"
            />

            {/* Central glassmorphic wallet & radar shield */}
            <rect
              x="86"
              y="48"
              width="68"
              height="64"
              rx="16"
              fill="#0f172a"
              fillOpacity="0.85"
              stroke="url(#stellarOrbitGrad)"
              strokeWidth="2"
            />
            {/* Wallet clasp & signal waves */}
            <rect
              x="100"
              y="64"
              width="40"
              height="28"
              rx="6"
              fill="#1e293b"
              stroke="#38bdf8"
              strokeWidth="1.5"
            />
            <circle cx="130" cy="78" r="3.5" fill="#22d3ee" />
            <path
              d="M108 58C115 52 125 52 132 58"
              stroke="#a855f7"
              strokeWidth="2"
              strokeLinecap="round"
            />

            {/* Satellite alert nodes */}
            <circle cx="44" cy="64" r="6" fill="#0f172a" stroke="#22d3ee" strokeWidth="2" />
            <circle cx="44" cy="64" r="2.5" fill="#22d3ee" />

            <circle cx="196" cy="92" r="6" fill="#0f172a" stroke="#c084fc" strokeWidth="2" />
            <circle cx="196" cy="92" r="2.5" fill="#c084fc" />

            <circle cx="172" cy="40" r="5" fill="#0f172a" stroke="#34d399" strokeWidth="1.75" />
            <circle cx="172" cy="40" r="2" fill="#34d399" />
          </svg>
        </div>

        {/* Heading & explanatory text */}
        <h2
          id="empty-watchers-heading"
          className="text-2xl md:text-3xl font-extrabold text-white tracking-tight"
        >
          {title}
        </h2>
        <p
          id="empty-watchers-description"
          className="mt-3 text-sm md:text-base text-slate-300 leading-relaxed max-w-2xl"
        >
          {description}
        </p>

        {/* Primary CTA Button */}
        <div className="mt-7">
          <button
            type="button"
            data-testid="add-first-wallet-cta"
            onClick={handlePrimaryAction}
            className="inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-2xl bg-gradient-to-r from-cyan-500 to-purple-600 hover:from-cyan-400 hover:to-purple-500 text-white font-semibold text-sm md:text-base shadow-lg shadow-cyan-500/20 hover:shadow-cyan-500/35 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 transition-all duration-200"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              +
            </span>
            <span>{ctaLabel}</span>
          </button>
        </div>
      </div>

      {/* Quick-Action Onboarding Cards */}
      <div
        role="list"
        aria-label="Onboarding quick actions"
        data-testid="empty-watchers-quick-actions"
        className="relative z-10 mt-10 grid grid-cols-1 md:grid-cols-3 gap-4"
      >
        {quickActions.map((action, index) => (
          <div
            key={action.id}
            role="listitem"
            data-testid={`quick-action-card-${index}`}
            onClick={() => {
              if (action.onSelect) {
                action.onSelect();
              } else {
                handlePrimaryAction();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (action.onSelect) {
                  action.onSelect();
                } else {
                  handlePrimaryAction();
                }
              }
            }}
            tabIndex={0}
            aria-label={`${action.title}: ${action.description}`}
            className="group cursor-pointer rounded-2xl bg-slate-950/50 border border-white/10 hover:border-cyan-500/40 p-5 text-left backdrop-blur-md transition-all duration-200 hover:bg-slate-900/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          >
            <div className="flex items-center justify-between gap-2 mb-3">
              <span className="inline-flex items-center justify-center h-7 w-7 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-mono text-xs font-bold">
                {action.step}
              </span>
              <span className="px-2.5 py-0.5 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-300 text-[11px] font-medium">
                {action.badge}
              </span>
            </div>
            <h3 className="text-base font-bold text-white group-hover:text-cyan-300 transition-colors">
              {action.title}
            </h3>
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              {action.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
};

export default EmptyWatchersState;
