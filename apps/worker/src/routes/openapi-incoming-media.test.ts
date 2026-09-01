import { describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { openapi } from './openapi.js';

describe('OpenAPI incoming-media contract', () => {
  test('documents only account-scoped HEAD and GET with service bearer auth', async () => {
    const app = new Hono();
    app.route('/', openapi);
    const response = await app.request('/openapi.json');
    expect(response.status).toBe(200);
    const spec = await response.json() as {
      components: { securitySchemes: Record<string, unknown> };
      paths: Record<string, Record<string, { security?: unknown; responses?: Record<string, unknown> }>>;
    };
    expect(spec.components.securitySchemes).toHaveProperty('incomingMediaServiceBearer');
    const metadata = spec.paths['/api/incoming-media/{accountId}/{messageId}'];
    const content = spec.paths['/api/incoming-media/{accountId}/{messageId}/content'];
    expect(Object.keys(metadata)).toEqual(['head']);
    expect(Object.keys(content)).toEqual(['get']);
    expect(metadata.head.security).toEqual([
      { bearerAuth: [] }, { incomingMediaServiceBearer: [] },
    ]);
    expect(content.get.responses).toHaveProperty('503');
  });
});
