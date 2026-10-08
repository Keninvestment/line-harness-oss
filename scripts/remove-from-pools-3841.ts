#!/usr/bin/env tsx
/** Remove one LINE account from every traffic pool, with a fail-closed default-account guard. */

import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  ForwardUrlStop, HARNESS_ORIGIN, loadHarnessApiKey, type Requester,
} from './set-forward-raw-url-3841.js';

const MAX_BYTES = 32_768;
const MAX_POOLS = 100;
const MAX_REMOVALS = 100;

interface TrafficPool {
  id: string;
  activeAccountId: string;
}

interface PoolMembership {
  id: string;
  poolId: string;
  lineAccountId: string;
}

export class PoolRemovalStop extends Error {
  constructor(readonly code: string) { super(code); }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

async function responseData(response: Response): Promise<unknown> {
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_BYTES ||
      !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new PoolRemovalStop('response_shape');
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new PoolRemovalStop('response_json'); }
  const envelope = value as { success?: unknown; data?: unknown };
  if (!response.ok || envelope.success !== true) throw new PoolRemovalStop('api_response');
  return envelope.data;
}

function parsePools(value: unknown): TrafficPool[] {
  if (!Array.isArray(value) || value.length > MAX_POOLS) throw new PoolRemovalStop('pool_limit');
  return value.map((item) => {
    const pool = item as { id?: unknown; activeAccountId?: unknown };
    if (!validId(pool.id) || !validId(pool.activeAccountId)) throw new PoolRemovalStop('pool_shape');
    return { id: pool.id, activeAccountId: pool.activeAccountId };
  });
}

function parseMemberships(value: unknown, poolId: string): PoolMembership[] {
  if (!Array.isArray(value)) throw new PoolRemovalStop('membership_shape');
  return value.map((item) => {
    const membership = item as { id?: unknown; poolId?: unknown; lineAccountId?: unknown };
    if (!validId(membership.id) || membership.poolId !== poolId || !validId(membership.lineAccountId)) {
      throw new PoolRemovalStop('membership_shape');
    }
    return { id: membership.id, poolId, lineAccountId: membership.lineAccountId };
  });
}

export async function run(
  raw: string[], deps: { apiKey: string; request: Requester },
): Promise<{ account_id: string; removed: number; remaining: number }> {
  const accountId = raw[0];
  if (raw.length !== 1 || !validId(accountId)) throw new PoolRemovalStop('arguments');
  const headers = { Authorization: `Bearer ${deps.apiKey}`, 'Accept-Encoding': 'identity' };
  const request = async (path: string, method = 'GET'): Promise<unknown> => {
    const response = await deps.request(`${HARNESS_ORIGIN}${path}`, {
      method, redirect: 'error', headers, signal: AbortSignal.timeout(30_000),
    });
    return responseData(response);
  };

  const pools = parsePools(await request('/api/traffic-pools'));
  if (pools.some((pool) => pool.activeAccountId === accountId)) {
    throw new PoolRemovalStop('pool_default_account');
  }

  const memberships: PoolMembership[] = [];
  for (const pool of pools) {
    const rows = parseMemberships(await request(`/api/traffic-pools/${encodeURIComponent(pool.id)}/accounts`), pool.id);
    memberships.push(...rows.filter((row) => row.lineAccountId === accountId));
  }
  if (memberships.length > MAX_REMOVALS) throw new PoolRemovalStop('removal_limit');

  for (const membership of memberships) {
    await request(
      `/api/traffic-pools/${encodeURIComponent(membership.poolId)}/accounts/${encodeURIComponent(membership.id)}`,
      'DELETE',
    );
  }

  let remaining = 0;
  for (const pool of pools) {
    const rows = parseMemberships(await request(`/api/traffic-pools/${encodeURIComponent(pool.id)}/accounts`), pool.id);
    remaining += rows.filter((row) => row.lineAccountId === accountId).length;
  }
  if (remaining !== 0) throw new PoolRemovalStop('readback_mismatch');
  return { account_id: accountId, removed: memberships.length, remaining };
}

const isCliEntry = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (isCliEntry) {
  let apiKey: string;
  try { apiKey = loadHarnessApiKey(); }
  catch (error) {
    const reason = error instanceof ForwardUrlStop ? error.code : 'local_error';
    stdout.write(`${JSON.stringify({ status: 'stopped', stop_reason: reason })}\n`); exit(1);
  }
  run(argv.slice(2), { apiKey, request: fetch })
    .then((result) => stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const reason = error instanceof PoolRemovalStop ? error.code : 'provider_or_local_error';
      stdout.write(`${JSON.stringify({ status: 'stopped', stop_reason: reason })}\n`); exit(1);
    });
}
