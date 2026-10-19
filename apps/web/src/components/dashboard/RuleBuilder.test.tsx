import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RuleBuilder, RuleAST } from './RuleBuilder';
import {
  generateStellarTestKeypair,
  verifyStellarSignature,
  STELLAR_SIGNATURE_HEADER,
} from '../../lib/wallet/signature-guard';

describe('RuleBuilder', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('exports a JSON AST payload for a single condition', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilder onSave={onSave} />);

    await user.type(screen.getByLabelText('Condition value'), '100');
    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    const expected: RuleAST = {
      logic: 'AND',
      conditions: [{ field: 'amount', operator: 'gt', value: '100' }],
    };
    expect(onSave).toHaveBeenCalledWith(expected);
    expect(screen.getByText(/JSON AST Preview/i)).toBeInTheDocument();
  });

  it('supports adding a second condition and switching to OR logic', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilder onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'OR' }));
    await user.click(screen.getByRole('button', { name: '+ Add Condition' }));

    const values = screen.getAllByLabelText('Condition value');
    await user.type(values[0], '50');
    await user.type(values[1], 'USDC');

    const fields = screen.getAllByLabelText('Condition field');
    await user.selectOptions(fields[1], 'asset');

    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    expect(onSave).toHaveBeenCalledWith({
      logic: 'OR',
      conditions: [
        { field: 'amount', operator: 'gt', value: '50' },
        { field: 'asset', operator: 'eq', value: 'USDC' },
      ],
    });
  });

  it('validates that a numeric amount is required before saving', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilder onSave={onSave} />);

    await user.type(screen.getByLabelText('Condition value'), 'not-a-number');
    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Amount must be a number.')).toBeInTheDocument();
  });

  it('rejects saving when a required value is left empty', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RuleBuilder onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Value is required.')).toBeInTheDocument();
  });

  it('requires non-custodial wallet signature re-authentication and sends X-Stellar-Signature header (#648)', async () => {
    const user = userEvent.setup();
    const keypair = await generateStellarTestKeypair();
    const onSave = vi.fn();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(
      <RuleBuilder
        onSave={onSave}
        requireSignature={true}
        walletAddress={keypair.publicKey}
        apiEndpoint="http://localhost:3001/rules"
        signer={async (challenge) => keypair.sign(challenge)}
      />
    );

    await user.type(screen.getByLabelText('Condition value'), '250');
    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    // WalletAuthModal opens before saving
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('wallet-auth-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('confirm-wallet-signature-btn'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    const [savedAst, proof] = onSave.mock.calls[0];
    expect(savedAst).toEqual({
      logic: 'AND',
      conditions: [{ field: 'amount', operator: 'gt', value: '250' }],
    });
    expect(proof.publicKey).toBe(keypair.publicKey);

    const verified = await verifyStellarSignature({
      publicKey: keypair.publicKey,
      challenge: proof.challenge,
      signature: proof.signature,
    });
    expect(verified).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/rules');
    expect(init.headers[STELLAR_SIGNATURE_HEADER]).toBe(proof.headerValue);
  });

  it('blocks rule mutation when the user rejects the wallet signature prompt (#648)', async () => {
    const user = userEvent.setup();
    const keypair = await generateStellarTestKeypair();
    const onSave = vi.fn();
    const onSignatureError = vi.fn();

    render(
      <RuleBuilder
        onSave={onSave}
        requireSignature={true}
        walletAddress={keypair.publicKey}
        onSignatureError={onSignatureError}
        signer={async () => {
          throw new Error('User rejected request in wallet');
        }}
      />
    );

    await user.type(screen.getByLabelText('Condition value'), '100');
    await user.click(screen.getByRole('button', { name: 'Save Rule' }));

    await user.click(screen.getByTestId('confirm-wallet-signature-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('wallet-auth-error')).toBeInTheDocument();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(onSignatureError).toHaveBeenCalledTimes(1);
  });
});
