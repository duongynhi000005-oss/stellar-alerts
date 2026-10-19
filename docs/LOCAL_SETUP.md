# Local Development Setup & Postman Collection Guide

This guide walks through starting the Stellar Alerts stack locally and importing the pre-configured Postman v2.1 collection (`stellar_alerts.postman_collection.json`) to test authenticated request flows.

## 1. Prerequisites & Services

- **Node.js** `>= 20.x`
- **PostgreSQL** `>= 15`
- **Redis** `>= 7`

Copy `.env.example` in `apps/api/` to `.env`, push the Prisma schema, and start the Fastify API server:

```bash
cd apps/api
cp .env.example .env
npm run db:push
npm run dev
```

By default, the API listens on `http://localhost:3001` and serves interactive Swagger/OpenAPI docs at `http://localhost:3001/docs`.

## 2. Importing the Postman Collection

1. Open Postman (or Newman CLI) and import [`stellar_alerts.postman_collection.json`](../stellar_alerts.postman_collection.json) from the repository root.
2. The collection comes pre-configured with collection-level variables:
   - `{{baseUrl}}`: Defaults to `http://localhost:3001`
   - `{{jwtToken}}`: Bearer JWT session token automatically populated by the **Auth -> Verify Magic Link** test script
   - `{{magicToken}}`: One-time magic link token printed in the API console or sent via email
   - `{{refreshToken}}`: Refresh token used with `POST /auth/refresh`
   - `{{walletId}}`: Automatically captured when executing **Wallets & Cursor Status -> Add Wallet**
   - `{{webhookId}}`: Target webhook ID for webhook management requests

## 3. Authenticated Request Flow

1. Run **Auth -> Request Magic Link** (`POST {{baseUrl}}/auth/request-link`).
2. Copy the magic token from the local dev console into `{{magicToken}}` and run **Auth -> Verify Magic Link** (`GET {{baseUrl}}/auth/verify?token={{magicToken}}`).
   - The post-response script automatically stores the returned JWT in `{{jwtToken}}`.
3. All protected folders (**Wallets & Cursor Status**, **Payments**, **Webhooks**, **Alert Rules & Notifications**, and **Exports, Simulation & GraphQL**) include `Authorization: Bearer {{jwtToken}}` headers and sample JSON request bodies ready for execution.
