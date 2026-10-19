import { FastifyInstance } from 'fastify';
import type { FastifyCorsOptions } from '@fastify/cors';

export const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000'] as const;

/**
 * Normalizes a comma-separated string or array of origin URLs into a strict
 * list of origins (scheme + host + optional port), stripping trailing slashes
 * and rejecting bare wildcard (`*`) entries.
 */
export function parseAllowedOrigins(rawOrigins?: string | string[]): string[] {
  const candidates: string[] = [];

  if (Array.isArray(rawOrigins)) {
    for (const item of rawOrigins) {
      candidates.push(...item.split(','));
    }
  } else if (typeof rawOrigins === 'string' && rawOrigins.trim().length > 0) {
    candidates.push(...rawOrigins.split(','));
  }

  const normalized = candidates
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => origin.length > 0 && origin !== '*');

  if (normalized.length === 0) {
    return [...DEFAULT_ALLOWED_ORIGINS];
  }

  return Array.from(new Set(normalized));
}

/**
 * Checks whether an incoming `Origin` header is permitted by the strict
 * origin whitelist. Server-to-server requests with no `Origin` header are
 * allowed (`true`); browser requests must match an explicit origin in
 * `allowedOrigins`.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (!origin) {
    return true;
  }
  const normalizedIncoming = origin.trim().replace(/\/+$/, '');
  if (!normalizedIncoming || normalizedIncoming === '*') {
    return false;
  }
  return allowedOrigins.includes(normalizedIncoming);
}

/**
 * Builds strict `@fastify/cors` configuration enforcing an explicit origin
 * whitelist (`APP_URL` / `CORS_ORIGIN` / `CSRF_ALLOWED_ORIGINS`) and blocking
 * unauthorized origins or wildcard reflection on credentialed endpoints.
 */
export function buildStrictCorsOptions(
  rawOrigins?: string | string[],
): FastifyCorsOptions {
  const allowedOrigins = parseAllowedOrigins(rawOrigins);

  return {
    origin: (origin, cb) => {
      if (isOriginAllowed(origin, allowedOrigins)) {
        cb(null, origin ? origin.trim().replace(/\/+$/, '') : true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'Idempotency-Key',
      'X-CSRF-Token',
    ],
    exposedHeaders: [
      'X-Request-Id',
      'Retry-After',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    maxAge: 86400,
    strictPreflight: false,
  };
}

/**
 * Registers a global `onSend` hook that attaches security response headers to
 * every reply produced by the API and strips wildcard CORS reflection on
 * sensitive routes.
 *
 * Headers applied:
 *   X-Content-Type-Options   — prevent MIME-sniffing
 *   X-Frame-Options          — deny framing (clickjacking protection)
 *   Referrer-Policy          — restrict referrer leakage
 *   Strict-Transport-Security — enforce HTTPS for 1 year with subdomains
 *   Permissions-Policy       — disable unused browser features
 *   Content-Security-Policy  — tight policy for API JSON responses
 *                              (no scripts/frames/plugins needed)
 *   X-Powered-By removal     — avoid advertising the server technology stack
 *
 * The hook is idempotent: it does not overwrite a header that was already set
 * by a route handler (e.g. a route that sends a PDF with its own content-type).
 */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  app.addHook('onSend', async (_request, reply, payload) => {
    // Only set a header when the route has not already done so.
    const setIfMissing = (name: string, value: string) => {
      if (!reply.hasHeader(name)) {
        reply.header(name, value);
      }
    };

    setIfMissing('X-Content-Type-Options', 'nosniff');
    setIfMissing('X-Frame-Options', 'DENY');
    setIfMissing('Referrer-Policy', 'strict-origin-when-cross-origin');
    setIfMissing(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload',
    );
    setIfMissing(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    // API responses are pure JSON — no scripts, no iframes, no plugins.
    setIfMissing(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none';",
    );
    setIfMissing('Cross-Origin-Opener-Policy', 'same-origin');
    setIfMissing('Cross-Origin-Resource-Policy', 'same-origin');

    // Guardrail: never emit wildcard Access-Control-Allow-Origin on API responses.
    if (reply.getHeader('access-control-allow-origin') === '*') {
      reply.removeHeader('access-control-allow-origin');
    }

    // Suppress technology-stack advertisement.
    reply.removeHeader('X-Powered-By');
    reply.removeHeader('server');

    return payload;
  });
}
