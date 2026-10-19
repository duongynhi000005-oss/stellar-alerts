import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CopyButton } from './CopyButton';
import { PaymentRow } from '../dashboard/PaymentRow';
import { WalletCard } from '../dashboard/WalletCard';

const SAMPLE_PUBLIC_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const SAMPLE_TX_HASH = 'a3f1e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0';

describe('CopyButton (#652)', () => {
  let writeTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('copies the value via navigator.clipboard.writeText and shows visual feedback for 2 seconds', async () => {
    vi.useFakeTimers();

    render(<CopyButton value={SAMPLE_PUBLIC_KEY} label="Copy Stellar public key" />);

    const button = screen.getByRole('button', { name: 'Copy Stellar public key' });
    expect(screen.getByTestId('copy-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('check-icon')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(SAMPLE_PUBLIC_KEY);

    // Visual checkmark icon + 'Copied!' tooltip + aria-live="polite" announcement
    expect(screen.getByTestId('check-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('copy-icon')).not.toBeInTheDocument();

    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    expect(liveRegion).toHaveTextContent('Copied!');

    // Still active at 1999ms
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(screen.getByTestId('check-icon')).toBeInTheDocument();

    // Reverts after 2000ms
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId('copy-icon')).toBeInTheDocument();
    expect(screen.queryByTestId('check-icon')).not.toBeInTheDocument();
    expect(liveRegion).toHaveTextContent('');
  });

  it('is keyboard accessible via Tab focus and Enter / Space activation', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: writeTextMock },
      configurable: true,
      writable: true,
    });

    render(<CopyButton value={SAMPLE_TX_HASH} label="Copy transaction hash" />);

    await user.tab();
    const button = screen.getByTestId('copy-button');
    expect(button).toHaveFocus();

    // Activate with Enter key
    await user.keyboard('{Enter}');
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(SAMPLE_TX_HASH);
    expect(screen.getByTestId('check-icon')).toBeInTheDocument();

    // Also supports Space key activation
    await act(async () => {
      fireEvent.keyDown(button, { key: ' ' });
    });
    expect(writeTextMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to document.execCommand("copy") when navigator.clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const execCommandMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: execCommandMock,
      configurable: true,
      writable: true,
    });

    render(<CopyButton value={SAMPLE_PUBLIC_KEY} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-button'));
    });

    expect(execCommandMock).toHaveBeenCalledWith('copy');
    expect(screen.getByTestId('check-icon')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Copied!');
  });

  it('integrates inside PaymentRow for both sender address and transaction hash', async () => {
    render(
      <table>
        <tbody>
          <PaymentRow
            payment={{
              id: 'pay-1',
              walletId: 'wal-1',
              txHash: SAMPLE_TX_HASH,
              fromAddress: SAMPLE_PUBLIC_KEY,
              amount: 250,
              asset: 'USDC',
              receivedAt: new Date('2026-03-01T12:00:00Z').toISOString(),
            }}
          />
        </tbody>
      </table>
    );

    const senderCopyBtn = screen.getByRole('button', {
      name: `Copy sender address ${SAMPLE_PUBLIC_KEY}`,
    });
    const txCopyBtn = screen.getByRole('button', {
      name: `Copy transaction hash ${SAMPLE_TX_HASH}`,
    });

    await act(async () => {
      fireEvent.click(senderCopyBtn);
    });
    expect(writeTextMock).toHaveBeenLastCalledWith(SAMPLE_PUBLIC_KEY);

    await act(async () => {
      fireEvent.click(txCopyBtn);
    });
    expect(writeTextMock).toHaveBeenLastCalledWith(SAMPLE_TX_HASH);
  });

  it('integrates inside WalletCard and stops click propagation to card selection', async () => {
    const onSelect = vi.fn();
    const onRemove = vi.fn();

    render(
      <WalletCard
        wallet={{
          id: 'wal-1',
          userId: 'usr-1',
          publicKey: SAMPLE_PUBLIC_KEY,
          label: 'Treasury Vault',
          createdAt: new Date().toISOString(),
        }}
        isSelected={false}
        onSelect={onSelect}
        onRemove={onRemove}
      />
    );

    const copyBtn = screen.getByRole('button', {
      name: `Copy wallet public key ${SAMPLE_PUBLIC_KEY}`,
    });

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(writeTextMock).toHaveBeenCalledWith(SAMPLE_PUBLIC_KEY);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
