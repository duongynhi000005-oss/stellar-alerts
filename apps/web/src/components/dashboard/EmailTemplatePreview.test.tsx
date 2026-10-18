import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  EmailTemplatePreview,
  DEFAULT_EMAIL_TEMPLATE,
  buildEmailTemplateHtml,
  normalizeHexColor,
  serializeEmailTemplateVariables,
} from './EmailTemplatePreview';

describe('EmailTemplatePreview', () => {
  it('renders the branding editor controls and a live email preview frame', () => {
    render(<EmailTemplatePreview />);

    expect(screen.getByRole('heading', { name: /Email Receipt Template/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Brand Name/i)).toHaveValue(DEFAULT_EMAIL_TEMPLATE.brandName);
    expect(screen.getByLabelText(/Brand Logo URL/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Primary Color/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Accent Color/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Footer Note/i)).toBeInTheDocument();
    expect(screen.getByTestId('email-preview-frame')).toBeInTheDocument();
  });

  it('builds email HTML that reflects custom brand logo and colors', () => {
    const html = buildEmailTemplateHtml({
      ...DEFAULT_EMAIL_TEMPLATE,
      brandName: 'Northwind Goods',
      logoUrl: 'https://cdn.example.com/northwind-logo.png',
      primaryColor: '#123456',
      accentColor: '#abcdef',
    });

    expect(html).toContain('Northwind Goods');
    expect(html).toContain('https://cdn.example.com/northwind-logo.png');
    expect(html).toContain('#123456');
    expect(html).toContain('#abcdef');
    expect(html).toContain(DEFAULT_EMAIL_TEMPLATE.amount);
    expect(html).toContain(DEFAULT_EMAIL_TEMPLATE.asset);
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

  it('serializes custom template variables for user preference storage', () => {
    const serialized = serializeEmailTemplateVariables({
      ...DEFAULT_EMAIL_TEMPLATE,
      brandName: '  LumenPay  ',
      logoUrl: ' https://cdn.example.com/lumen.svg ',
      primaryColor: '#369',
      accentColor: '#f80',
    });

    expect(serialized.brandName).toBe('LumenPay');
    expect(serialized.logoUrl).toBe('https://cdn.example.com/lumen.svg');
    expect(serialized.primaryColor).toBe('#336699');
    expect(serialized.accentColor).toBe('#ff8800');
    expect(serialized.emailHtml).toContain('LumenPay');
    expect(serialized.emailHtml).toContain('#336699');
  });

  it('updates live iframe preview in real-time and resets to defaults', () => {
    render(<EmailTemplatePreview />);

    fireEvent.change(screen.getByLabelText(/Brand Name/i), {
      target: { value: 'Orbit Commerce' },
    });
    fireEvent.change(screen.getByLabelText(/Brand Logo URL/i), {
      target: { value: 'https://cdn.example.com/orbit.png' },
    });

    const iframe = screen.getByTestId('email-preview-frame');
    expect(iframe.getAttribute('srcDoc')).toContain('Orbit Commerce');
    expect(iframe.getAttribute('srcDoc')).toContain('https://cdn.example.com/orbit.png');

    fireEvent.click(screen.getByRole('button', { name: /Reset Defaults/i }));
    expect(screen.getByLabelText(/Brand Name/i)).toHaveValue(DEFAULT_EMAIL_TEMPLATE.brandName);
  });

  it('supports modal dialog open/close behavior', () => {
    const onClose = vi.fn();
    const { rerender } = render(<EmailTemplatePreview isOpen={false} onClose={onClose} />);
    expect(screen.queryByTestId('email-preview-frame')).not.toBeInTheDocument();

    rerender(<EmailTemplatePreview isOpen={true} onClose={onClose} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close Preview/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('invokes onSaveTemplate with the customized template variables', async () => {
    const onSaveTemplate = vi.fn().mockResolvedValue(undefined);
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
});