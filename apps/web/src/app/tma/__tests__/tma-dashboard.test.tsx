import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TMADashboard, { type RecentPayment } from '../tma-dashboard';
import type { TmaAuthResult } from '../tma.helpers';
import type { WalletDTO } from '@stellar-alerts/shared';
import * as haptics from '../haptics';

vi.mock('../haptics', () => ({
  selection: vi.fn(),
  impact: vi.fn(),
  notify: vi.fn(),
}));

const mockSession: TmaAuthResult = {
  token: 'mock-jwt-token',
  email: 'tg_123456@telegram.stellar-alerts.org',
  telegramName: 'Alex Mercer',
  telegramId: 123456789,
};

const mockWallets: WalletDTO[] = [
  {
    id: 'w-1',
    userId: 'u-1',
    publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    label: 'Main Treasury',
    createdAt: new Date('2026-01-01'),
  },
  {
    id: 'w-2',
    userId: 'u-1',
    publicKey: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
    label: 'Cold Vault',
    createdAt: new Date('2026-01-02'),
  },
];

const mockPayments: RecentPayment[] = [
  {
    id: 'p-1',
    amount: '1250.50',
    asset: 'XLM',
    receivedAt: '2026-10-24T02:00:00.000Z',
  },
  {
    id: 'p-2',
    amount: '500.00',
    asset: 'USDC',
    receivedAt: '2026-10-24T02:15:00.000Z',
  },
];

describe('<TMADashboard />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders mobile-optimized Telegram theme dashboard container with recent payments', () => {
    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={mockPayments}
        telegramAlerts={true}
        onToggleTelegramAlerts={vi.fn()}
        onRemoveWallet={vi.fn()}
        onAddWallet={vi.fn()}
        newKey=""
        setNewKey={vi.fn()}
        formError={null}
        busy={false}
      />,
    );

    const dashboard = screen.getByTestId('tma-dashboard');
    expect(dashboard).toBeInTheDocument();
    expect(screen.getByText('Recent payment pushes')).toBeInTheDocument();
    expect(screen.getByText('+1250.50 XLM')).toBeInTheDocument();
    expect(screen.getByText('+500.00 USDC')).toBeInTheDocument();
  });

  it('triggers haptics selection when clicking on a recent payment push', () => {
    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={mockPayments}
        telegramAlerts={true}
        onToggleTelegramAlerts={vi.fn()}
        onRemoveWallet={vi.fn()}
        onAddWallet={vi.fn()}
        newKey=""
        setNewKey={vi.fn()}
        formError={null}
        busy={false}
      />,
    );

    const paymentItem = screen.getByText('+1250.50 XLM').closest('li');
    expect(paymentItem).not.toBeNull();
    fireEvent.click(paymentItem!);

    expect(haptics.selection).toHaveBeenCalled();
  });

  it('displays empty state fallback when recent payments list is empty', () => {
    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={[]}
        telegramAlerts={true}
        onToggleTelegramAlerts={vi.fn()}
        onRemoveWallet={vi.fn()}
        onAddWallet={vi.fn()}
        newKey=""
        setNewKey={vi.fn()}
        formError={null}
        busy={false}
      />,
    );

    expect(screen.getByText('No recent payments yet.')).toBeInTheDocument();
  });

  it('toggles Telegram push notifications and triggers haptics', async () => {
    const onToggleTelegramAlerts = vi.fn().mockResolvedValue(undefined);

    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={mockPayments}
        telegramAlerts={true}
        onToggleTelegramAlerts={onToggleTelegramAlerts}
        onRemoveWallet={vi.fn()}
        onAddWallet={vi.fn()}
        newKey=""
        setNewKey={vi.fn()}
        formError={null}
        busy={false}
      />,
    );

    const toggle = screen.getByRole('switch', { name: /Toggle Telegram notifications/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    expect(haptics.selection).toHaveBeenCalled();
    expect(onToggleTelegramAlerts).toHaveBeenCalledTimes(1);
  });

  it('toggles Soroban smart contract events and triggers haptics', () => {
    const onToggleSorobanAlerts = vi.fn();

    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={mockPayments}
        telegramAlerts={true}
        onToggleTelegramAlerts={vi.fn()}
        sorobanAlerts={false}
        onToggleSorobanAlerts={onToggleSorobanAlerts}
        onRemoveWallet={vi.fn()}
        onAddWallet={vi.fn()}
        newKey=""
        setNewKey={vi.fn()}
        formError={null}
        busy={false}
      />,
    );

    const sorobanToggle = screen.getByRole('switch', { name: /Toggle Soroban contract events/i });
    expect(sorobanToggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(sorobanToggle);

    expect(haptics.selection).toHaveBeenCalled();
    expect(sorobanToggle).toHaveAttribute('aria-checked', 'true');
    expect(onToggleSorobanAlerts).toHaveBeenCalledTimes(1);
  });

  it('toggles Whale transaction filter and triggers haptics', () => {
    const onToggleWhaleAlerts = vi.fn();

    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={mockPayments}
        telegramAlerts={true}
        onToggleTelegramAlerts={vi.fn()}
        whaleAlerts={false}
        onToggleWhaleAlerts={onToggleWhaleAlerts}
        onRemoveWallet={vi.fn()}
        onAddWallet={vi.fn()}
        newKey=""
        setNewKey={vi.fn()}
        formError={null}
        busy={false}
      />,
    );

    const whaleToggle = screen.getByRole('switch', { name: /Toggle Whale transaction filter/i });
    expect(whaleToggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(whaleToggle);

    expect(haptics.selection).toHaveBeenCalled();
    expect(whaleToggle).toHaveAttribute('aria-checked', 'true');
    expect(onToggleWhaleAlerts).toHaveBeenCalledTimes(1);
  });

  it('renders watched wallets and invokes onRemoveWallet with haptic impact', () => {
    const onRemoveWallet = vi.fn();

    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={mockPayments}
        telegramAlerts={true}
        onToggleTelegramAlerts={vi.fn()}
        onRemoveWallet={onRemoveWallet}
        onAddWallet={vi.fn()}
        newKey=""
        setNewKey={vi.fn()}
        formError={null}
        busy={false}
      />,
    );

    expect(screen.getByText('Watched wallets (2)')).toBeInTheDocument();
    expect(screen.getByText('Main Treasury')).toBeInTheDocument();
    expect(screen.getByText('GBBD…FLA5')).toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: /Remove wallet GBBD…FLA5/i });
    fireEvent.click(removeBtn);

    expect(haptics.impact).toHaveBeenCalledWith('medium');
    expect(onRemoveWallet).toHaveBeenCalledWith('w-1');
  });

  it('submits add wallet form and triggers onAddWallet', () => {
    const onAddWallet = vi.fn((e) => e.preventDefault());
    const setNewKey = vi.fn();

    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={mockPayments}
        telegramAlerts={true}
        onToggleTelegramAlerts={vi.fn()}
        onRemoveWallet={vi.fn()}
        onAddWallet={onAddWallet}
        newKey="GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        setNewKey={setNewKey}
        formError={null}
        busy={false}
      />,
    );

    const input = screen.getByLabelText(/Add a wallet/i);
    expect(input).toHaveValue('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

    const submitBtn = screen.getByRole('button', { name: /Add wallet/i });
    fireEvent.click(submitBtn);

    expect(onAddWallet).toHaveBeenCalled();
  });

  it('renders validation error message when formError is provided', () => {
    render(
      <TMADashboard
        session={mockSession}
        wallets={mockWallets}
        recentPayments={mockPayments}
        telegramAlerts={true}
        onToggleTelegramAlerts={vi.fn()}
        onRemoveWallet={vi.fn()}
        onAddWallet={vi.fn()}
        newKey="invalid-key"
        setNewKey={vi.fn()}
        formError="Enter a valid Stellar public key (starts with G, 56 characters)."
        busy={false}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a valid Stellar public key (starts with G, 56 characters).',
    );
  });
});
