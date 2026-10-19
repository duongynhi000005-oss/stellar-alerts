import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

interface PostmanHeader {
  key: string;
  value: string;
  type?: string;
}

interface PostmanRequestItem {
  name: string;
  request?: {
    method: string;
    header?: PostmanHeader[];
    auth?: {
      type: string;
      bearer?: Array<{ key: string; value: string }>;
    };
    body?: {
      mode: string;
      raw?: string;
    };
    url: {
      raw: string;
      host: string[];
      path: string[];
    };
  };
  item?: PostmanRequestItem[];
}

function flattenRequests(items: PostmanRequestItem[]): PostmanRequestItem[] {
  const result: PostmanRequestItem[] = [];
  for (const entry of items) {
    if (entry.request) {
      result.push(entry);
    }
    if (Array.isArray(entry.item)) {
      result.push(...flattenRequests(entry.item));
    }
  }
  return result;
}

describe('Postman Collection v2.1 Schema & Authenticated Flows (#653)', () => {
  const rootCollectionPath = path.resolve(
    __dirname,
    '../../../../stellar_alerts.postman_collection.json'
  );
  const apiCollectionPath = path.resolve(
    __dirname,
    '../../stellar_alerts.postman_collection.json'
  );

  it('validates JSON syntax, Postman v2.1.0 schema header, and synchronization between root and apps/api collections', () => {
    const rootRaw = fs.readFileSync(rootCollectionPath, 'utf8');
    const apiRaw = fs.readFileSync(apiCollectionPath, 'utf8');

    const collection = JSON.parse(rootRaw);
    const apiCollection = JSON.parse(apiRaw);

    expect(collection).toEqual(apiCollection);
    expect(collection.info?.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    );
    expect(collection.auth?.type).toBe('bearer');
    expect(collection.auth?.bearer?.[0]?.value).toBe('{{jwtToken}}');
  });

  it('defines {{baseUrl}} and {{jwtToken}} variable presets and valid JSON sample bodies across all API route groups', () => {
    const collection = JSON.parse(fs.readFileSync(rootCollectionPath, 'utf8'));
    const variables: Array<{ key: string; value: string }> =
      collection.variable ?? [];
    const varKeys = new Set(variables.map((v) => v.key));

    expect(varKeys.has('baseUrl')).toBe(true);
    expect(varKeys.has('jwtToken')).toBe(true);
    expect(varKeys.has('walletId')).toBe(true);
    expect(varKeys.has('webhookId')).toBe(true);

    const requests = flattenRequests(collection.item ?? []);
    expect(requests.length).toBeGreaterThanOrEqual(15);

    const rawUrls = requests.map((r) => r.request!.url.raw);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/health/deep'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/metrics'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/wallets/{{walletId}}/cursor'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/webhooks'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/alert-rules'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/notifications/preferences'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/dead-letters'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/exports'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/simulation'))).toBe(true);
    expect(rawUrls.some((u) => u.includes('{{baseUrl}}/graphql'))).toBe(true);

    // Every request with a raw JSON body must parse without syntax errors
    for (const req of requests) {
      if (req.request?.body?.mode === 'raw' && req.request.body.raw) {
        expect(() => JSON.parse(req.request!.body!.raw!)).not.toThrow();
      }
    }

    // Protected endpoints include Authorization: Bearer {{jwtToken}}
    const protectedRequests = requests.filter((r) =>
      r.request!.url.raw.match(
        /\/(wallets|payments|webhooks|alert-rules|notifications|dead-letters|exports|simulation|graphql)/
      )
    );
    expect(protectedRequests.length).toBeGreaterThanOrEqual(10);
    for (const req of protectedRequests) {
      const authHeader = (req.request!.header ?? []).find(
        (h) => h.key.toLowerCase() === 'authorization'
      );
      expect(authHeader?.value).toBe('Bearer {{jwtToken}}');
    }
  });
});
