import React, { useState, useEffect, useRef, useCallback } from 'react';

export interface CopyButtonProps {
  /** The string value to copy to the clipboard. */
  value?: string;
  /** Optional alias for `value` for convenience across callers. */
  text?: string;
  /** Accessible label for screen readers and button title. */
  label?: string;
  /** Tooltip / announcement text shown after copying (defaults to 'Copied!'). */
  copiedLabel?: string;
  /** Duration in milliseconds before reverting to idle icon (defaults to 2000ms). */
  resetDelayMs?: number;
  /** Additional Tailwind CSS classes for the button element. */
  className?: string;
  /** Size variant for the button icon and padding. */
  size?: 'sm' | 'md';
  /** Optional callback fired after a successful copy. */
  onCopy?: (copiedValue: string) => void;
}

async function writeTextToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy textarea fallback if Clipboard API is blocked
    }
  }

  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }

  return false;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  value,
  text,
  label = 'Copy to clipboard',
  copiedLabel = 'Copied!',
  resetDelayMs = 2000,
  className = '',
  size = 'sm',
  onCopy,
}) => {
  const targetValue = value ?? text ?? '';
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  const triggerCopy = useCallback(async () => {
    if (!targetValue) return;

    const didCopy = await writeTextToClipboard(targetValue);
    if (!didCopy) return;

    clearTimer();
    setCopied(true);
    onCopy?.(targetValue);

    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, resetDelayMs);
  }, [targetValue, clearTimer, onCopy, resetDelayMs]);

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    void triggerCopy();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      e.stopPropagation();
      void triggerCopy();
    }
  };

  const iconSizeClass = size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5';
  const paddingClass = size === 'md' ? 'p-1.5' : 'p-1';

  return (
    <button
      type="button"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      data-testid="copy-button"
      data-copied={copied ? 'true' : 'false'}
      className={`relative inline-flex items-center justify-center rounded-md border transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-cyan-500/60 cursor-pointer ${paddingClass} ${
        copied
          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
          : 'bg-slate-800/60 hover:bg-slate-800 border-slate-700/60 hover:border-slate-600 text-slate-400 hover:text-slate-200'
      } ${className}`}
    >
      {copied ? (
        <svg
          data-testid="check-icon"
          className={`${iconSizeClass} text-emerald-400`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2.5}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg
          data-testid="copy-icon"
          className={iconSizeClass}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}

      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="copy-tooltip"
        className={
          copied
            ? 'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-emerald-400 border border-emerald-500/40 shadow-lg z-20'
            : 'sr-only'
        }
      >
        {copied ? copiedLabel : ''}
      </span>
    </button>
  );
};

export const CopyToClipboard = CopyButton;
export default CopyButton;
