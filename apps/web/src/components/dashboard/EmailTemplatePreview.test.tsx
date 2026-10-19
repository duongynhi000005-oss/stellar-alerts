import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  EmailTemplatePreview,
  DEFAULT_EMAIL_TEMPLATE,
  USER_EMAIL_TEMPLATE_PREF_KEY,
  buildEmailTemplateHtml,
  interpolateEmailTemplateTokens,
  normalizeHexColor,
  saveEmailTemplatePreferences,
} from './EmailTemplatePreview';

describe('EmailTemplatePreview', () => {
  it('renders the branding editor controls and a live email preview frame', () => {
    render(<EmailTemplatePreview />);

    expect(screen.getByRole('heading', { name: /Email Receipt Template/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Brand Name/i)).toHaveValue(DEFAULT_EMAIL_TEMPLATE.brandName);
    expect(screen.getByLabelText(/Brand Logo URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Primary Color/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Accent Color/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Message Body Template/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Footer Note/i)).toBeInTheDocument();
    expect(screen.getByTestId('email-preview-frame')).toBeInTheDocument();
  });

  it('builds email HTML that reflects custom brand logo, colors, and placeholder tokens', () => {
    const html = buildEmailTemplateHtml({
      ...DEFAULT_EMAIL_TEMPLATE,
      brandName: 'Northwind Goods',
      logoUrl: 'https://cdn.example.com/northwind-logo.png',
      primaryColor: '#123456',
      accentColor: '#abcdef',
      bodyTemplate: 'Received {{amount}} {{asset}} for {{brandName}} (tx {{txHash}})',
    });

    expect(html).toContain('Northwind Goods');
    expect(html).toContain('https://cdn.example.com/northwind-logo.png');
    expect(html).toContain('#123456');
    expect(html).toContain('#abcdef');
    expect(html).toContain(
      `Received ${DEFAULT_EMAIL_TEMPLATE.amount} ${DEFAULT_EMAIL_TEMPLATE.asset} for Northwind Goods`
    );
  });

  it('interpolates placeholder tokens accurately', () => {
    const result = interpolateEmailTemplateTokens(
      'Alert for {{brandName}}: {{amount}} {{asset}} from {{fromAddress}} ({{txHash}})',
      {
        ...DEFAULT_EMAIL_TEMPLATE,
        brandName: 'OrbitPay',
        amount: '99.5',
        asset: 'XLM',
        fromAddress: 'GABC123',
        txHash: 'deadbeef',
      }
    );

    expect(result).toBe('Alert for OrbitPay: 99.5 XLM from GABC123 (deadbeef)');
  });

  it('falls back to a monogram when no logo URL is provided', () => {
    const html = buildEmailTemplateHtml({ ...DEFAULT_EMAIL_TEMPLATE, logoUrl: '' });
    expect(html).not.toContain('<img src=');
  });

  it('normalizes malformed hex colors to a safe default', () => {
    expect(normalizeHexColor('zzz')).toBe('#0ea5e9');
    expect(normalizeHexColor('#f80')).toBe('#ff8800');
    expect(normalizeHexColor('  #0EA5E9  ')).toBe('#0ea5e9');
  });

  it('invokes onSaveTemplate and persists to user preference schema', async () => {
    const onSaveTemplate = vi.fn().mockResolvedValue(undefined);
    const mockSetItem = vi.fn();
    const pref = saveEmailTemplatePreferences(
      { ...DEFAULT_EMAIL_TEMPLATE, brandName: 'Acme Coffee', primaryColor: '#112233' },
      { setItem: mockSetItem }
    );
    expect(pref.schemaVersion).toBe(1);
    expect(pref.emailTemplate.brandName).toBe('Acme Coffee');
    expect(pref.emailTemplate.primaryColor).toBe('#112233');
    expect(mockSetItem).toHaveBeenCalledWith(
      USER_EMAIL_TEMPLATE_PREF_KEY,
      expect.stringContaining('Acme Coffee')
    );

    render(<EmailTemplatePreview onSaveTemplate={onSaveTemplate} />);

    fireEvent.change(screen.getByLabelText(/Brand Name/i), {
      target: { value: 'Acme Coffee' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Template/i }));

    expect(onSaveTemplate).toHaveBeenCalledTimes(1);
    expect(onSaveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ brandName: 'Acme Coffee' })
    );
    expect(await screen.findByText('✓ Saved')).toBeInTheDocument();
  });

  it('opens and closes the interactive preview modal with viewport switching', () => {
    render(<EmailTemplatePreview />);

    expect(screen.queryByTestId('email-preview-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('open-preview-modal-btn'));

    const modal = screen.getByTestId('email-preview-modal');
    expect(modal).toBeInTheDocument();
    const frame = screen.getByTestId('email-modal-preview-frame');
    expect(frame).toHaveStyle({ width: '100%' });

    fireEvent.click(screen.getByTestId('viewport-mobile-btn'));
    expect(frame).toHaveStyle({ width: '375px' });

    fireEvent.click(screen.getByTestId('close-preview-modal-btn'));
    expect(screen.queryByTestId('email-preview-modal')).not.toBeInTheDocument();
  });
});