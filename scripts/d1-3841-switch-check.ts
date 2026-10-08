#!/usr/bin/env tsx
/** Read-only, sanitized D1 checks for the #3841 LINE account switch. */

import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  exactHttpsRequest, loadToken, type ExactRequest, type HttpResponse,
} from './worker-b1-deploy-5229.js';

const ACCOUNT_ID = '67907592fdf596376bc2097e14a6563a';
const DATABASE_ID = 'c19584d7-e9f1-4d46-83c5-6c0ba96561d1';
const MAX_BYTES = 131_072;

type Scalar = string | number | null;
type Row = Record<string, Scalar>;
export type Query = (sql: string, params: Scalar[]) => Promise<Row[]>;

export class SwitchCheckStop extends Error {
  constructor(readonly code: string) { super(code); }
}

export function assertSingleSelect(sql: string): void {
  const trimmed = sql.trim();
  const withoutFinal = trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed;
  if (!/^(?:SELECT\b|WITH\b[\s\S]*\bSELECT\b)/i.test(withoutFinal) || withoutFinal.includes(';') ||
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|ALTER|DROP|CREATE|PRAGMA|ATTACH|DETACH|VACUUM)\b/i.test(withoutFinal)) {
    throw new SwitchCheckStop('non_select_statement');
  }
}

function parseRows(response: HttpResponse): Row[] {
  const type = response.headers['content-type'];
  const media = (Array.isArray(type) ? type[0] : type)?.split(';', 1)[0].trim().toLowerCase();
  if (response.status !== 200 || media !== 'application/json') throw new SwitchCheckStop('d1_response');
  let value: unknown;
  try { value = JSON.parse(response.body.toString('utf8')); } catch { throw new SwitchCheckStop('d1_json'); }
  const envelope = value as { success?: unknown; result?: Array<{ success?: unknown; results?: unknown }> };
  if (envelope.success !== true || envelope.result?.length !== 1 || envelope.result[0]?.success !== true ||
      !Array.isArray(envelope.result[0].results)) throw new SwitchCheckStop('d1_shape');
  return envelope.result[0].results as Row[];
}

export function createQuery(token: string): Query {
  return async (sql, params) => {
    assertSingleSelect(sql);
    const body = Buffer.from(JSON.stringify({ sql, params }), 'utf8');
    const spec: ExactRequest = {
      hostname: 'api.cloudflare.com', method: 'POST',
      path: `/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'Accept-Encoding': 'identity', 'Content-Length': body.length,
      },
      body, maxBytes: MAX_BYTES,
    };
    return parseRows(await exactHttpsRequest(spec, Date.now() + 60_000));
  };
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SwitchCheckStop(`invalid_${key}`);
  }
  return value;
}

function one(rows: Row[]): Row {
  if (rows.length !== 1) throw new SwitchCheckStop('row_count');
  return rows[0];
}

function parseChannel(value: string | undefined): string {
  if (!value || !/^[0-9]+$/.test(value)) throw new SwitchCheckStop('channel_id');
  return value;
}

export function normalizeSince(value: string | undefined): string {
  if (!value) throw new SwitchCheckStop('since');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new SwitchCheckStop('since');
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().replace(/Z$/, '+09:00');
}

const GLOBAL_SQL = `SELECT
  (SELECT COUNT(*) FROM scenarios WHERE is_active = 1 AND trigger_type = 'friend_add' AND line_account_id IS NULL) AS scenarios,
  (SELECT COUNT(*) FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL) AS auto_replies,
  (SELECT COUNT(*) FROM automations WHERE is_active = 1 AND line_account_id IS NULL) AS automations,
  (SELECT COUNT(*) FROM outgoing_webhooks WHERE is_active = 1) AS outgoing_webhooks,
  (SELECT COUNT(*) FROM scoring_rules WHERE is_active = 1) AS scoring_rules,
  (SELECT COUNT(*) FROM entry_routes WHERE is_active = 1) AS entry_routes`;

const ACCOUNTS_SQL = `WITH target AS (
  SELECT id FROM line_accounts WHERE channel_id = ?
)
SELECT
  (SELECT COUNT(*) FROM line_accounts) AS total_accounts,
  (SELECT COUNT(*) FROM line_accounts WHERE is_active = 1) AS active_accounts,
  (SELECT COUNT(*) FROM target) AS matching_accounts,
  (SELECT MAX(id) FROM target) AS account_id,
  (SELECT COUNT(*) FROM pool_accounts pa JOIN target t ON t.id = pa.line_account_id
    WHERE pa.is_active = 1) AS pool_memberships_active,
  (SELECT COUNT(*) FROM traffic_pools tp JOIN target t ON t.id = tp.active_account_id)
    AS pool_default_account_count`;

const SETTINGS_SQL = `SELECT la.id AS account_id,
  SUM(CASE WHEN s.key = 'forward_raw_url' THEN 1 ELSE 0 END) AS forward_raw_url_count
FROM line_accounts la
LEFT JOIN account_settings s ON s.line_account_id = la.id AND s.key = 'forward_raw_url'
GROUP BY la.id
ORDER BY la.id`;

const POST_SQL = `WITH target AS (
  SELECT id, is_active FROM line_accounts WHERE channel_id = ? LIMIT 1
)
SELECT
  (SELECT COUNT(*) FROM target) AS matching_accounts,
  (SELECT COUNT(*) FROM target WHERE is_active = 1) AS active_accounts,
  (SELECT COUNT(*) FROM account_settings aset JOIN target t ON t.id = aset.line_account_id
    WHERE aset.key = 'forward_raw_url') AS forward_raw_url_count,
  (SELECT COUNT(*) FROM pool_accounts pa JOIN target t ON t.id = pa.line_account_id
    WHERE pa.is_active = 1) AS pool_memberships_active,
  (SELECT COUNT(*) FROM traffic_pools tp JOIN target t ON t.id = tp.active_account_id)
    AS pool_default_account_count,
  (SELECT COUNT(*) FROM friends f JOIN target t ON t.id = f.line_account_id) AS friends_total,
  (SELECT COUNT(*) FROM friends f JOIN target t ON t.id = f.line_account_id
    WHERE f.created_at >= ?) AS friends_since,
  (SELECT COUNT(*) FROM messages_log ml JOIN friends f ON f.id = ml.friend_id CROSS JOIN target t
    WHERE (ml.line_account_id = t.id OR (ml.line_account_id IS NULL AND f.line_account_id = t.id))
      AND ml.direction = 'incoming' AND ml.created_at >= ?) AS incoming_since,
  (SELECT COUNT(*) FROM messages_log ml JOIN friends f ON f.id = ml.friend_id CROSS JOIN target t
    WHERE (ml.line_account_id = t.id OR (ml.line_account_id IS NULL AND f.line_account_id = t.id))
      AND ml.direction = 'outgoing' AND ml.created_at >= ?) AS outgoing_since,
  (SELECT COUNT(*) FROM friend_scenarios fs JOIN friends f ON f.id = fs.friend_id JOIN target t ON t.id = f.line_account_id
    WHERE fs.started_at >= ?) AS enrollments_since`;

export async function run(raw: string[], query: Query): Promise<Record<string, unknown>> {
  const mode = raw[0];
  if (raw[1] !== '--channel-id') throw new SwitchCheckStop('arguments');
  const channelId = parseChannel(raw[2]);
  if (mode === 'preswitch' && raw.length === 3) {
    const global = one(await query(GLOBAL_SQL, []));
    const accounts = one(await query(ACCOUNTS_SQL, [channelId]));
    const settingsRows = await query(SETTINGS_SQL, []);
    const globalCounts = {
      scenarios: integer(global, 'scenarios'), auto_replies: integer(global, 'auto_replies'),
      automations: integer(global, 'automations'),
    };
    const reviewCounts = {
      outgoing_webhooks: integer(global, 'outgoing_webhooks'),
      scoring_rules: integer(global, 'scoring_rules'), entry_routes: integer(global, 'entry_routes'),
    };
    const settings = settingsRows.map((row) => {
      if (typeof row.account_id !== 'string') throw new SwitchCheckStop('invalid_account_id');
      return { account_id: row.account_id, forward_raw_url_count: integer(row, 'forward_raw_url_count') };
    });
    const globalRulesPass = Object.values(globalCounts).every((count) => count === 0);
    const reviewRequired = Object.values(reviewCounts).some((count) => count > 0);
    const exists = integer(accounts, 'matching_accounts') === 1;
    const poolMemberships = integer(accounts, 'pool_memberships_active');
    const poolDefaultAccounts = integer(accounts, 'pool_default_account_count');
    const poolStop = exists && (poolMemberships > 0 || poolDefaultAccounts > 0);
    return {
      mode, verdict: !globalRulesPass ? 'STOP_GLOBAL_RULES' : poolStop ? 'STOP_POOL_MEMBERSHIP' : 'PASS',
      channel_id: channelId,
      global_rule_counts: globalCounts,
      review_counts: reviewCounts,
      review_required: reviewRequired,
      line_accounts: {
        total: integer(accounts, 'total_accounts'), active: integer(accounts, 'active_accounts'),
        channel_exists: exists,
        account_id: typeof accounts.account_id === 'string' ? accounts.account_id : null,
      },
      pool_memberships_active: poolMemberships,
      pool_default_account_count: poolDefaultAccounts,
      forward_raw_url_by_account: settings,
    };
  }
  if (mode === 'postswitch' && raw[3] === '--since' && raw.length === 5) {
    const since = normalizeSince(raw[4]);
    const row = one(await query(POST_SQL, [channelId, since, since, since, since]));
    const exists = integer(row, 'matching_accounts') === 1;
    const active = exists && integer(row, 'active_accounts') === 1;
    const hasForward = exists && integer(row, 'forward_raw_url_count') === 1;
    const poolMemberships = integer(row, 'pool_memberships_active');
    const poolDefaultAccounts = integer(row, 'pool_default_account_count');
    const outgoing = integer(row, 'outgoing_since');
    const enrollments = integer(row, 'enrollments_since');
    return {
      mode, verdict: exists && active && hasForward && poolMemberships === 0 && poolDefaultAccounts === 0 &&
        outgoing === 0 && enrollments === 0 ? 'PASS' : 'FAIL',
      channel_id: channelId, since,
      account_exists: exists, account_active: active, has_forward_raw_url: hasForward,
      pool_memberships_active: poolMemberships,
      pool_default_account_count: poolDefaultAccounts,
      friends: integer(row, 'friends_total'), friends_created_since: integer(row, 'friends_since'),
      messages_incoming_since: integer(row, 'incoming_since'), messages_outgoing_since: outgoing,
      friend_scenario_enrollments_since: enrollments,
    };
  }
  throw new SwitchCheckStop('arguments');
}

const isCliEntry = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (isCliEntry) {
  run(argv.slice(2), createQuery(loadToken()))
    .then((result) => stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const reason = error instanceof SwitchCheckStop ? error.code : 'provider_or_local_error';
      stdout.write(`${JSON.stringify({ status: 'stopped', stop_reason: reason })}\n`);
      exit(1);
    });
}
