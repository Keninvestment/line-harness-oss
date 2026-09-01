import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { IncomingMediaRow } from '@line-crm/db';
import type { Env } from '../index.js';

const dbMocks = vi.hoisted(() => ({
  getStaffByApiKey: vi.fn(),
  getIncomingMediaServiceCredentialById: vi.fn(),
  getStoredIncomingMedia: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);

import { authMiddleware } from '../middleware/auth.js';
import { incomingMedia } from './incoming-media.js';

function storedRow(): IncomingMediaRow {
  return {
    id: 'media-1', line_account_id: 'acc-1', line_message_id: 'msg-1',
    source_type: 'group', source_id: 'C123', sender_user_id: 'U456',
    r2_key: `incoming-${'a'.repeat(64)}`, mime_type: 'image/png', byte_size: 4,
    sha256: 'b'.repeat(64), status: 'stored',
    stored_at: '2026-08-31T12:00:01.000+09:00',
    created_at: '2026-08-31T12:00:00.000+09:00',
    updated_at: '2026-08-31T12:00:01.000+09:00',
  };
}

function setupApp() {
  const row = storedRow();
  const metadata = {
    size: row.byte_size ?? 0,
    httpMetadata: { contentType: row.mime_type ?? '' },
    customMetadata: { sha256: row.sha256 ?? '', byteSize: String(row.byte_size) },
  };
  const r2 = {
    head: vi.fn(async (key: string) => key === row.r2_key
      ? ({ key, ...metadata } as unknown as R2Object) : null),
    get: vi.fn(async (key: string) => key === row.r2_key
      ? ({ body: new Uint8Array([1, 2, 3, 4]), ...metadata } as unknown as R2ObjectBody) : null),
  };
  const app = new Hono<Env>();
  app.use('*', authMiddleware);
  app.route('/', incomingMedia);
  const env = {
    API_KEY: 'owner-key', DB: {} as D1Database, IMAGES: r2 as unknown as R2Bucket,
  } as Env['Bindings'];
  return { app, env, r2, row };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getStaffByApiKey.mockResolvedValue(null);
  dbMocks.getIncomingMediaServiceCredentialById.mockResolvedValue(null);
  dbMocks.getStoredIncomingMedia.mockResolvedValue(storedRow());
});

const SERVICE_ID = 'a'.repeat(32);
const SERVICE_TOKEN = `lhim_v1.${SERVICE_ID}.${'b'.repeat(64)}`;

async function serviceCredential(accountId = 'acc-1') {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SERVICE_TOKEN)),
  );
  return {
    id: SERVICE_ID, line_account_id: accountId, scope: 'incoming_media_read',
    token_sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    label: 'accounting recovery', not_before: '2026-08-31T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z', revoked_at: null,
    created_at: '2026-08-31T00:00:00.000Z',
  };
}

describe('private incoming-media retrieval', () => {
  test.each([
    ['HEAD', '/api/incoming-media/acc-1/msg-1'],
    ['GET', '/api/incoming-media/acc-1/msg-1/content'],
  ])('requires authentication for %s', async (method, path) => {
    const { app, env } = setupApp();
    const res = await app.request(path, { method }, env);
    expect(res.status).toBe(401);
    expect(dbMocks.getStoredIncomingMedia).not.toHaveBeenCalled();
  });

  test('rejects ordinary staff before media or R2 lookup', async () => {
    dbMocks.getStaffByApiKey.mockResolvedValueOnce({ id: 's', name: 'S', role: 'staff' });
    const { app, env, r2 } = setupApp();
    const res = await app.request('/api/incoming-media/acc-1/msg-1/content', {
      headers: { Authorization: 'Bearer staff-key' },
    }, env);
    expect(res.status).toBe(403);
    expect(dbMocks.getStoredIncomingMedia).not.toHaveBeenCalled();
    expect(r2.get).not.toHaveBeenCalled();
  });

  test.each([
    ['HEAD', '/api/incoming-media/acc-1/msg-1'],
    ['GET', '/api/incoming-media/acc-1/msg-1/content'],
  ])('allows account-scoped service credential for %s', async (method, path) => {
    dbMocks.getIncomingMediaServiceCredentialById.mockResolvedValueOnce(await serviceCredential());
    const { app, env } = setupApp();
    const res = await app.request(path, {
      method, headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    }, env);
    expect(res.status).toBe(200);
    expect(dbMocks.getStaffByApiKey).not.toHaveBeenCalled();
  });

  test('returns non-enumerating 404 for another account', async () => {
    dbMocks.getIncomingMediaServiceCredentialById.mockResolvedValueOnce(await serviceCredential('acc-2'));
    const { app, env, r2 } = setupApp();
    const res = await app.request('/api/incoming-media/acc-1/msg-1/content', {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    }, env);
    expect(res.status).toBe(404);
    expect(dbMocks.getStoredIncomingMedia).not.toHaveBeenCalled();
    expect(r2.get).not.toHaveBeenCalled();
  });

  test('does not allow the service credential on another API route', async () => {
    dbMocks.getIncomingMediaServiceCredentialById.mockResolvedValue(await serviceCredential());
    const app = new Hono<Env>();
    app.use('*', authMiddleware);
    app.get('/api/friends', (c) => c.json({ success: true }));
    const res = await app.request('/api/friends', {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    }, setupApp().env);
    expect(res.status).toBe(401);
    expect(dbMocks.getIncomingMediaServiceCredentialById).not.toHaveBeenCalled();
  });

  test.each([
    ['GET', '/api/incoming-media/acc-1/msg-1'],
    ['HEAD', '/api/incoming-media/acc-1/msg-1/content'],
  ])('does not widen credential to %s %s', async (method, path) => {
    const { app, env } = setupApp();
    const res = await app.request(path, {
      method, headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    }, env);
    expect(res.status).toBe(401);
    expect(dbMocks.getIncomingMediaServiceCredentialById).not.toHaveBeenCalled();
  });

  test('accepts service credential only as Bearer', async () => {
    const { app, env } = setupApp();
    const res = await app.request('/api/incoming-media/acc-1/msg-1/content', {
      headers: { Cookie: `lh_admin_session=${SERVICE_TOKEN}` },
    }, env);
    expect(res.status).toBe(401);
    expect(dbMocks.getIncomingMediaServiceCredentialById).not.toHaveBeenCalled();
  });

  test('HEAD returns private integrity metadata', async () => {
    const { app, env, row, r2 } = setupApp();
    const res = await app.request('/api/incoming-media/acc-1/msg-1', {
      method: 'HEAD', headers: { Authorization: 'Bearer owner-key' },
    }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(res.headers.get('X-Content-SHA256')).toBe('b'.repeat(64));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(r2.head).toHaveBeenCalledWith(row.r2_key);
  });

  test('GET streams only the D1-resolved object', async () => {
    const { app, env, row, r2 } = setupApp();
    const res = await app.request('/api/incoming-media/acc-1/msg-1/content', {
      headers: { Authorization: 'Bearer owner-key' },
    }, env);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(res.headers.get('X-Content-SHA256')).toBe(row.sha256);
    expect(r2.get).toHaveBeenCalledWith(row.r2_key);
  });

  test('fails closed on integrity mismatch', async () => {
    const { app, env, r2 } = setupApp();
    r2.head.mockResolvedValueOnce({ key: storedRow().r2_key, size: 999,
      httpMetadata: { contentType: 'image/png' } } as R2Object);
    const res = await app.request('/api/incoming-media/acc-1/msg-1', {
      method: 'HEAD', headers: { Authorization: 'Bearer owner-key' },
    }, env);
    expect(res.status).toBe(503);
  });

  test('returns private 503 when credential storage fails', async () => {
    dbMocks.getIncomingMediaServiceCredentialById.mockRejectedValueOnce(new Error('D1 down'));
    const { app, env, r2 } = setupApp();
    const res = await app.request('/api/incoming-media/acc-1/msg-1/content', {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(r2.get).not.toHaveBeenCalled();
  });
});
