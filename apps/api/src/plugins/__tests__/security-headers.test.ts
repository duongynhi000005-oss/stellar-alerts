import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import {
  buildContentSecurityPolicy,
  generateNonce,
  securityHeadersPlugin,
  SecurityHeadersOptions,
} from '../security-headers';

describe('security-headers: generateNonce & buildContentSecurityPolicy helpers', () => {
  it('generates a 128-bit cryptographically secure random base64 nonce', () => {
    const nonce = generateNonce(16);
    expect(typeof nonce).toBe('string');
    // 16 bytes in base64 is 24 characters with padding
    expect(nonce.length).toBe(24);
    // Valid base64 regex
    expect(/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)).toBe(true);
  });

  it('generates unique nonces across multiple iterations', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 50; i++) {
      nonces.add(generateNonce(16));
    }
    expect(nonces.size).toBe(50);
  });

  it('builds strict production CSP with dynamic nonce and strict-dynamic', () => {
    const nonce = 'dGVzdG5vbmNlMTIzNDU2';
    const csp = buildContentSecurityPolicy(nonce, { isDev: false });

    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('upgrade-insecure-requests');

    // Production policy must not have unsafe-inline in script-src or style-src
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('builds development CSP allowing unsafe-eval in scripts and unsafe-inline in styles', () => {
    const nonce = 'dGVzdG5vbmNlMTIzNDU2';
    const csp = buildContentSecurityPolicy(nonce, { isDev: true });

    expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`);
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`);
    expect(csp).not.toContain('upgrade-insecure-requests');
  });

  it('supports appending additional trusted script and style sources', () => {
    const nonce = 'dGVzdG5vbmNlMTIzNDU2';
    const csp = buildContentSecurityPolicy(nonce, {
      isDev: false,
      additionalScriptSrc: ['https://www.google-analytics.com'],
      additionalStyleSrc: ['https://fonts.googleapis.com'],
    });

    expect(csp).toContain('https://www.google-analytics.com');
    expect(csp).toContain('https://fonts.googleapis.com');
  });
});

describe('security-headers Fastify plugin', () => {
  async function createServer(options: SecurityHeadersOptions = {}) {
    const app = Fastify({ logger: false });
    await app.register(securityHeadersPlugin, options);

    app.get('/test', async (req) => {
      return {
        ok: true,
        reqNonce: req.nonce,
        rawNonce: (req.raw as any).nonce,
      };
    });

    app.get('/custom-csp', async (_req, reply) => {
      reply.header('Content-Security-Policy', "default-src 'self' https://custom.domain;");
      return { ok: true };
    });

    await app.ready();
    return app;
  }

  it('generates a unique nonce and sets Content-Security-Policy header on every reply', async () => {
    const app = await createServer({ isDev: false });

    const res1 = await app.inject({ method: 'GET', url: '/test' });
    expect(res1.statusCode).toBe(200);

    const csp1 = res1.headers['content-security-policy'] as string;
    expect(csp1).toBeDefined();
    expect(csp1).toContain("'strict-dynamic'");

    const nonce1Match = csp1.match(/'nonce-([^']+)'/);
    expect(nonce1Match).not.toBeNull();
    const nonce1 = nonce1Match![1];

    const body1 = JSON.parse(res1.body);
    expect(body1.reqNonce).toBe(nonce1);
    expect(body1.rawNonce).toBe(nonce1);
    expect(res1.headers['x-nonce']).toBe(nonce1);

    // Second request must have a different unique nonce
    const res2 = await app.inject({ method: 'GET', url: '/test' });
    const csp2 = res2.headers['content-security-policy'] as string;
    const nonce2 = csp2.match(/'nonce-([^']+)'/)![1];

    expect(nonce2).toBeDefined();
    expect(nonce2).not.toBe(nonce1);

    await app.close();
  });

  it('attaches standard defense-in-depth security headers', async () => {
    const app = await createServer();
    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['permissions-policy']).toContain('camera=()');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['server']).toBeUndefined();

    await app.close();
  });

  it('preserves route-specific CSP when preserveRouteCsp is true', async () => {
    const app = await createServer({ preserveRouteCsp: true });
    const res = await app.inject({ method: 'GET', url: '/custom-csp' });

    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain('https://custom.domain');

    await app.close();
  });

  it('sets Content-Security-Policy-Report-Only when reportOnly is enabled', async () => {
    const app = await createServer({ reportOnly: true });
    const res = await app.inject({ method: 'GET', url: '/test' });

    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['content-security-policy-report-only']).toBeDefined();
    expect(res.headers['content-security-policy-report-only']).toContain("'strict-dynamic'");

    await app.close();
  });

  it('supports 256-bit (32 bytes) nonce size configuration', async () => {
    const app = await createServer({ nonceBytes: 32 });
    const res = await app.inject({ method: 'GET', url: '/test' });

    const body = JSON.parse(res.body);
    // 32 bytes in base64 is 44 characters
    expect(body.reqNonce.length).toBe(44);

    await app.close();
  });
});
