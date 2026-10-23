import { proxy as middleware, config } from '../proxy';

/**
 * Next.js Edge Middleware for Content-Security-Policy (CSP) Dynamic Nonce Injection.
 *
 * Enforces per-request cryptographic nonces across script tags and response headers,
 * forwarding 'x-nonce' to Server Components and setting strict security headers.
 */

export { middleware, config };
export default middleware;
