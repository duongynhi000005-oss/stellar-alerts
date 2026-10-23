import { describe, it, expect, vi } from 'vitest';

vi.mock('next/server', () => {
  class _MockHeaders {
    private store = new Map<string, string>();
    constructor(init?: any) {
      if (init && typeof init.forEach === 'function') {
        init.forEach((v: string, k: string) => this.store.set(k.toLowerCase(), v));
      } else if (init && typeof init === 'object') {
        Object.entries(init as Record<string, string>).forEach(([k, v]) =>
          this.store.set(k.toLowerCase(), v),
        );
      }
    }
    set(name: string, value: string) { this.store.set(name.toLowerCase(), value); }
    get(name: string): string | null { return this.store.get(name.toLowerCase()) ?? null; }
    has(name: string): boolean { return this.store.has(name.toLowerCase()); }
    forEach(cb: (v: string, k: string) => void) { this.store.forEach(cb); }
  }

  class _MockNextRequest {
    url: string;
    headers: _MockHeaders;
    constructor(url: string, init?: { headers?: Record<string, string> }) {
      this.url = url;
      this.headers = new _MockHeaders(init?.headers ?? {});
    }
  }

  class _MockNextResponse {
    headers: _MockHeaders;
    constructor() { this.headers = new _MockHeaders(); }
    static next(): _MockNextResponse { return new _MockNextResponse(); }
  }

  return { NextRequest: _MockNextRequest, NextResponse: _MockNextResponse };
});

import { NextRequest as MockNextRequest } from 'next/server';
import middleware, { config } from '../../middleware';

describe('Next.js middleware entrypoint (apps/web/src/middleware.ts)', () => {
  it('exports middleware function and matcher config', () => {
    expect(typeof middleware).toBe('function');
    expect(config).toBeDefined();
    expect(Array.isArray(config.matcher)).toBe(true);
  });

  it('generates per-request CSP nonce via middleware invocation', () => {
    const req = new MockNextRequest('https://app.example.com/dashboard');
    const res = middleware(req as any);

    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeDefined();
    expect(csp).toContain("'nonce-");
    expect(csp).toContain("'strict-dynamic'");
  });
});
