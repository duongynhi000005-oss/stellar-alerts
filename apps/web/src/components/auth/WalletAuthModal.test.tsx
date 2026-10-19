import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalletAuthModal } from './WalletAuthModal';
import {
  generateStellarTestKeypair,
  verifyStellarSignature,
  SignedMutationProof,
} from '../../lib/wallet/signature-guard';

describe('WalletAuthModal (#648)', () => {
  it('prompts the user to sign a timestamped challenge and returns a cryptographically valid proof', async () => {
    const user = userEvent.setup();
    const keypair = await generateStellarTestKeypair();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <WalletAuthModal
        isOpen={true}
        onClose={onClose}
        onSuccess={onSuccess}
        publicKey={keypair.publicKey}
        action="RULE_MUTATION"
        actionLabel="Update Alert Rule"
        payload={{ logic: 'AND', conditions: [{ field: 'amount', operator: 'gt', value: '250' }] }}
        signer={async (challenge) => keypair.sign(challenge)}
        verifyCryptographically={true}
      />
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('challenge-preview')).toHaveTextContent('Action: RULE_MUTATION');

    await user.click(screen.getByTestId('confirm-wallet-signature-btn'));

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    const proof: SignedMutationProof = onSuccess.mock.calls[0][0];
    expect(proof.publicKey).toBe(keypair.publicKey);

    const verified = await verifyStellarSignature({
      publicKey: proof.publicKey,
      challenge: proof.challenge,
      signature: proof.signature,
    });
    expect(verified).toBe(true);
  });

  it('displays an error alert and does not call onSuccess when the user rejects the signature request', async () => {
    const user = userEvent.setup();
    const keypair = await generateStellarTestKeypair();
    const onSuccess = vi.fn();
    const onError = vi.fn();

    render(
      <WalletAuthModal
        isOpen={true}
        onClose={() => {}}
        onSuccess={onSuccess}
        onError={onError}
        publicKey={keypair.publicKey}
        action="RULE_MUTATION"
        payload={{ logic: 'OR', conditions: [] }}
        signer={async () => {
          throw new Error('User declined signature request in Freighter');
        }}
      />
    );

    await user.click(screen.getByTestId('confirm-wallet-signature-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('wallet-auth-error')).toHaveTextContent(
        /rejected or cancelled/i
      );
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
