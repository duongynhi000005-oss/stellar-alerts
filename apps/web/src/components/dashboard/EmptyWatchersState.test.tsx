import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyWatchersState } from './EmptyWatchersState';

describe('EmptyWatchersState', () => {
  it('renders onboarding illustration, explanatory copy, quick-action cards, and Add Your First Wallet CTA', () => {
    render(<EmptyWatchersState />);

    expect(screen.getByTestId('empty-watchers-state')).toBeInTheDocument();
    expect(screen.getByTestId('empty-watchers-illustration')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /no wallets monitored yet/i })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/add your first stellar wallet address to stream incoming transactions/i)
    ).toBeInTheDocument();

    const ctaButton = screen.getByRole('button', { name: /add your first wallet/i });
    expect(ctaButton).toBeInTheDocument();

    expect(screen.getByTestId('quick-action-card-0')).toBeInTheDocument();
    expect(screen.getByTestId('quick-action-card-1')).toBeInTheDocument();
    expect(screen.getByTestId('quick-action-card-2')).toBeInTheDocument();
  });

  it('triggers onAddFirstWallet callback when primary CTA button or quick-action card is clicked', () => {
    const onAddFirstWallet = vi.fn();
    render(<EmptyWatchersState onAddFirstWallet={onAddFirstWallet} />);

    const ctaButton = screen.getByTestId('add-first-wallet-cta');
    fireEvent.click(ctaButton);
    expect(onAddFirstWallet).toHaveBeenCalledTimes(1);

    const firstCard = screen.getByTestId('quick-action-card-0');
    fireEvent.click(firstCard);
    expect(onAddFirstWallet).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(firstCard, { key: 'Enter' });
    expect(onAddFirstWallet).toHaveBeenCalledTimes(3);
  });

  it('supports onOpenAddModal callback and smooth scroll fallback when no callback is provided', () => {
    const onOpenAddModal = vi.fn();
    const { unmount } = render(<EmptyWatchersState onOpenAddModal={onOpenAddModal} />);

    fireEvent.click(screen.getByTestId('add-first-wallet-cta'));
    expect(onOpenAddModal).toHaveBeenCalledTimes(1);
    unmount();

    const target = document.createElement('div');
    target.id = 'add-wallet-section';
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;
    document.body.appendChild(target);

    render(<EmptyWatchersState />);
    fireEvent.click(screen.getByTestId('add-first-wallet-cta'));
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth' });

    document.body.removeChild(target);
  });
});
