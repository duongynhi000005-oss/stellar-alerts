import { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import crypto from 'crypto';

/**
 * Strict Content-Security-Policy (CSP) with Dynamic Nonce Pipeline.
 *
 * Implements per-request cryptographically secure 128-bit base64 nonces,
 * attaches nonces to request context (`request.raw.nonce` and `request.nonce`),
 * and enforces strict script/style evaluation with 'strict-dynamic' and 'nonce-...'.
 */

export interface SecurityHeadersOptions {
  /** Size in bytes for the cryptographically random nonce (default 16 = 128-bit). */
  nonceBytes?: number;
  /** Force dev mode CSP settings (default: evaluates process.env.NODE_ENV === 'development'). */
  isDev?: boolean;
  /** Use Content-Security-Policy-Report-Only instead of enforcing Content-Security-Policy. */
  reportOnly?: boolean;
  /** Optional custom script domains to whitelist (e.g. ['https://www.google-analytics.com']). */
  additionalScriptSrc?: string[];
  /** Optional custom style domains to whitelist. */
  additionalStyleSrc?: string[];
  /** Additional custom directives to append or override. */
  customDirectives?: Record<string, string>;
  /** If true, preserves existing Content-Security-Policy on reply if set by route handler. Default: true. */
  preserveRouteCsp?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    nonce: string;
  }
}

declare module 'http' {
  interface IncomingMessage {
    nonce?: string;
  }
}

/**
 * Generates a cryptographically secure random base64 nonce.
 * Default 16 bytes = 128-bit entropy.
 */
export function generateNonce(bytes = 16): string {
  const size = Math.max(16, bytes);
  return crypto.randomBytes(size).toString('base64');
}

/**
 * Builds the strict Content-Security-Policy string containing the dynamic request nonce.
 */
export function buildContentSecurityPolicy(
  nonce: string,
  options: SecurityHeadersOptions = {},
): string {
  const isDev =
    options.isDev ?? (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test');

  const extraScripts =
    options.additionalScriptSrc && options.additionalScriptSrc.length > 0
      ? ` ${options.additionalScriptSrc.join(' ')}`
      : '';

  const extraStyles =
    options.additionalStyleSrc && options.additionalStyleSrc.length > 0
      ? ` ${options.additionalStyleSrc.join(' ')}`
      : '';

  // script-src: 'strict-dynamic' allows trusted scripts to load child dependencies.
  // In development, 'unsafe-eval' is permitted for React/bundler source maps & HMR.
  const scriptDirectives = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    isDev ? "'unsafe-eval'" : null,
  ]
    .filter(Boolean)
    .join(' ');

  // style-src: in dev mode, CSS-in-JS and Tailwind inject dynamic inline styles.
  const styleDirectives = [
    "'self'",
    `'nonce-${nonce}'`,
    isDev ? "'unsafe-inline'" : null,
  ]
    .filter(Boolean)
    .join(' ');

  const directives: Record<string, string> = {
    'default-src': "'self'",
    'script-src': `${scriptDirectives}${extraScripts}`,
    'style-src': `${styleDirectives}${extraStyles}`,
    'img-src': "'self' data: blob: https:",
    'font-src': "'self' data:",
    'connect-src': "'self' https:",
    'object-src': "'none'",
    'base-uri': "'none'",
    'form-action': "'self'",
    'frame-ancestors': "'none'",
  };

  if (!isDev) {
    directives['upgrade-insecure-requests'] = '';
  }

  // Apply custom directives overrides if configured
  if (options.customDirectives) {
    for (const [key, value] of Object.entries(options.customDirectives)) {
      directives[key] = value;
    }
  }

  return Object.entries(directives)
    .map(([key, val]) => (val ? `${key} ${val}` : key))
    .join('; ')
    .trim()
    .concat(';');
}

const pluginFn: FastifyPluginAsync<SecurityHeadersOptions> = async (
  fastify: FastifyInstance,
  options: SecurityHeadersOptions = {},
) => {
  const preserveRouteCsp = options.preserveRouteCsp ?? true;
  const cspHeaderName = options.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';

  // Decorate FastifyRequest with default empty nonce string so property is typed
  if (!fastify.hasRequestDecorator('nonce')) {
    fastify.decorateRequest('nonce', '');
  }

  // 1. Generate unique cryptographic nonce per incoming request
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    const nonce = generateNonce(options.nonceBytes ?? 16);
    request.nonce = nonce;
    if (request.raw) {
      (request.raw as any).nonce = nonce;
    }
  });

  // 2. Attach strict Content-Security-Policy and standard security response headers
  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    const nonce = request.nonce || generateNonce(options.nonceBytes ?? 16);

    const setIfMissing = (headerName: string, headerValue: string) => {
      if (!reply.hasHeader(headerName)) {
        reply.header(headerName, headerValue);
      }
    };

    // Attach Content-Security-Policy
    if (!reply.hasHeader(cspHeaderName) || !preserveRouteCsp) {
      const csp = buildContentSecurityPolicy(nonce, options);
      reply.header(cspHeaderName, csp);
    }

    // Attach x-nonce header for edge proxies / SSR templates
    setIfMissing('x-nonce', nonce);

    // Standard defense-in-depth security headers
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

    // Suppress fingerprinting headers
    reply.removeHeader('X-Powered-By');
    reply.removeHeader('Server');

    return payload;
  });
};

export const securityHeadersPlugin = fp(pluginFn, {
  fastify: '5.x',
  name: 'security-headers',
});

export default securityHeadersPlugin;
