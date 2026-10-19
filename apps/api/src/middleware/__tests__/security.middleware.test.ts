import { describe, it, expect, beforeAll } from 'vitest';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  buildStrictCorsOptions,
  isOriginAllowed,
  parseAllowedOrigins,
  registerSecurityHeaders,
} from '../security.middleware';

async function buildTestApp(allowedOrigins = 'https://app.stellaralerts.io,http://localhost:3000') {
  const app = Fastify({ logger: false });
  await registerSecurityHeaders(app);
  await app.register(cors, buildStrictCorsOptions(allowedOrigins));

  app.get('/ping', async () => ({ pong: true }));
  app.get('/custom-csp', async (_req, reply) => {
    // A route that sets its own CSP should not be overwritten.
    reply.header('Content-Security-Policy', "default-src 'self' https://example.com;");
    return { ok: true };
  });
  app.get('/accidental-wildcard', async (_req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    return { ok: true };
  });

  await app.ready();
  return app;
}

describe('Security headers and strict CORS middleware (#565)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: DENY', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets Referrer-Policy: strict-origin-when-cross-origin', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('sets Strict-Transport-Security with 1-year max-age and includeSubDomains', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const hsts = res.headers['strict-transport-security'] as string;
    expect(hsts).toContain('max-age=31536000');
    expect(hsts).toContain('includeSubDomains');
  });

  it('sets Permissions-Policy disabling camera, mic, geolocation and payment', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const pp = res.headers['permissions-policy'] as string;
    expect(pp).toContain('camera=()');
    expect(pp).toContain('microphone=()');
    expect(pp).toContain('geolocation=()');
    expect(pp).toContain('payment=()');
  });

  it('sets a restrictive Content-Security-Policy on API responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('does not overwrite a CSP header already set by the route handler', async () => {
    const res = await app.inject({ method: 'GET', url: '/custom-csp' });
    expect(res.headers['content-security-policy']).toContain('https://example.com');
  });

  it('removes the X-Powered-By header', async () => {
    const res = await app.inject({ method: 'GET', url: '/ping' });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('applies headers to 4xx responses too', async () => {
    const res = await app.inject({ method: 'GET', url: '/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('strips accidental wildcard Access-Control-Allow-Origin headers on responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/accidental-wildcard' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  describe('Strict CORS origin whitelist & preflight OPTIONS', () => {
    it('parses allowed origins and rejects bare wildcard (*)', () => {
      expect(parseAllowedOrigins('https://app.example.com/, *, http://localhost:3000/')).toEqual([
        'https://app.example.com',
        'http://localhost:3000',
      ]);
      expect(parseAllowedOrigins('*')).toEqual(['http://localhost:3000']);
      expect(isOriginAllowed('https://app.example.com', ['https://app.example.com'])).toBe(true);
      expect(isOriginAllowed('https://evil.example.com', ['https://app.example.com'])).toBe(false);
    });

    it('returns matching Access-Control-Allow-Origin on preflight OPTIONS from whitelisted APP_URL', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://app.stellaralerts.io',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'Content-Type,Authorization',
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.stellaralerts.io');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
    });

    it('blocks unauthorized origins on preflight OPTIONS and standard requests', async () => {
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/ping',
        headers: {
          origin: 'https://malicious.attacker.example',
          'access-control-request-method': 'GET',
        },
      });
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();

      const getRes = await app.inject({
        method: 'GET',
        url: '/ping',
        headers: {
          origin: 'https://malicious.attacker.example',
        },
      });
      expect(getRes.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
