#!/usr/bin/env tsx
/** One-shot, sanitized UTAGE webhook response probe for #3841. */

import { createHash, createHmac } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  assertSingleSelect, createQuery, type Query, type Row,
} from './d1-3841-switch-check.js';
import {
  exactHttpsRequest, loadToken, type ExactRequest, type HttpResponse,
} from './worker-b1-deploy-5229.js';

const CREDENTIALS_SQL = 'SELECT channel_secret, channel_access_token FROM line_accounts WHERE channel_id = ? AND is_active = 1';
const LINE_USER_ID = /^U[0-9a-f]{32}$/;
const APPROVAL_ID = /^3841-PR-[0-9]{8}$/;
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 10_000;

export class UtageProbeStop extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface ProbeTarget {
  hostname: string;
  path: string;
  pathSha256: string;
}

export interface ProbeDependencies {
  loadTarget: (path: string) => ProbeTarget;
  createQuery: () => Query;
  lineRequest: (request: ExactRequest, expiresAt: number) => Promise<HttpResponse>;
  utageRequest: (request: ExactRequest, expiresAt: number) => Promise<HttpResponse>;
  now: () => number;
}

interface Arguments {
  channelId: string;
  urlFile: string;
  approvalId: string;
  badSignature: boolean;
}

export interface ProbeResult {
  approval_id: string;
  host: string;
  path_sha256: string;
  destination_ok: boolean;
  status: number;
  redirected: boolean;
  location_same_host: boolean | null;
  response_content_type: string;
  response_bytes: number;
  elapsed_ms: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(raw: string[]): Arguments {
  if (raw.length !== 6 && raw.length !== 8) throw new UtageProbeStop('arguments');
  if (raw[0] !== '--channel-id' || raw[2] !== '--url-file' || raw[4] !== '--approval-id') {
    throw new UtageProbeStop('arguments');
  }
  const channelId = raw[1];
  const urlFile = raw[3];
  const approvalId = raw[5];
  if (!/^[0-9]+$/.test(channelId)) throw new UtageProbeStop('channel_id');
  if (!urlFile) throw new UtageProbeStop('url_file');
  if (!APPROVAL_ID.test(approvalId)) throw new UtageProbeStop('approval_id');
  const badSignature = raw.length === 8;
  if (badSignature && (raw[6] !== '--signature' || raw[7] !== 'bad')) {
    throw new UtageProbeStop('signature_mode');
  }
  return { channelId, urlFile, approvalId, badSignature };
}

export function loadTarget(path: string): ProbeTarget {
  let stat;
  try { stat = lstatSync(path); } catch { throw new UtageProbeStop('url_file'); }
  if (stat.isSymbolicLink()) throw new UtageProbeStop('url_file_symlink');
  if (!stat.isFile()) throw new UtageProbeStop('url_file_type');
  if ((stat.mode & 0o777) !== 0o600) throw new UtageProbeStop('url_file_mode');
  let url: URL;
  try { url = new URL(readFileSync(path, 'utf8').trim()); } catch { throw new UtageProbeStop('url'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) {
    throw new UtageProbeStop('url');
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'utage-system.com' && !hostname.endsWith('.utage-system.com')) {
    throw new UtageProbeStop('url_host');
  }
  const requestPath = `${url.pathname}${url.search}`;
  return { hostname, path: requestPath, pathSha256: sha256(requestPath) };
}

export function computeSignature(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

function wrongSignature(correct: string): string {
  return `${correct[0] === 'A' ? 'B' : 'A'}${correct.slice(1)}`;
}

function stringField(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0) throw new UtageProbeStop(`invalid_${key}`);
  return value;
}

function contentType(response: HttpResponse): string {
  const value = response.headers['content-type'];
  return ((Array.isArray(value) ? value[0] : value) ?? '').split(';', 1)[0].trim().toLowerCase();
}

function lineDestination(response: HttpResponse): string {
  if (response.status !== 200) throw new UtageProbeStop('line_status');
  let parsed: unknown;
  try { parsed = JSON.parse(response.body.toString('utf8')); } catch { throw new UtageProbeStop('line_json'); }
  const userId = (parsed as { userId?: unknown }).userId;
  if (typeof userId !== 'string' || !LINE_USER_ID.test(userId)) throw new UtageProbeStop('line_destination');
  return userId;
}

function locationSameHost(response: HttpResponse, target: ProbeTarget): boolean | null {
  if (response.status < 300 || response.status >= 400) return null;
  const value = response.headers.location;
  const location = Array.isArray(value) ? value[0] : value;
  if (!location) return null;
  try {
    const resolved = new URL(location, `https://${target.hostname}${target.path}`);
    return resolved.host.toLowerCase() === target.hostname;
  } catch {
    return null;
  }
}

export async function run(raw: string[], deps: ProbeDependencies): Promise<ProbeResult> {
  const args = parseArguments(raw);
  const target = deps.loadTarget(args.urlFile);
  assertSingleSelect(CREDENTIALS_SQL);
  const rows = await deps.createQuery()(CREDENTIALS_SQL, [args.channelId]);
  if (rows.length !== 1) throw new UtageProbeStop('row_count');
  const secret = stringField(rows[0], 'channel_secret');
  const accessToken = stringField(rows[0], 'channel_access_token');

  const lineResponse = await deps.lineRequest({
    hostname: 'api.line.me', method: 'GET', path: '/v2/bot/info',
    headers: { Authorization: `Bearer ${accessToken}`, 'Accept-Encoding': 'identity' },
    maxBytes: MAX_RESPONSE_BYTES,
  }, deps.now() + TIMEOUT_MS);
  const userId = lineDestination(lineResponse);
  const body = Buffer.from(JSON.stringify({ destination: userId, events: [] }), 'utf8');
  const correctSignature = computeSignature(secret, body);
  const signature = args.badSignature ? wrongSignature(correctSignature) : correctSignature;

  const startedAt = deps.now();
  const response = await deps.utageRequest({
    hostname: target.hostname, method: 'POST', path: target.path,
    headers: {
      'Content-Type': 'application/json',
      'X-Line-Signature': signature,
      'User-Agent': 'LineBotWebhook/2.0',
      'Accept-Encoding': 'identity',
      'Content-Length': body.length,
    },
    body, maxBytes: MAX_RESPONSE_BYTES,
  }, startedAt + TIMEOUT_MS);
  const elapsedMs = Math.max(0, deps.now() - startedAt);
  return {
    approval_id: args.approvalId,
    host: target.hostname,
    path_sha256: target.pathSha256,
    destination_ok: true,
    status: response.status,
    redirected: response.status >= 300 && response.status < 400,
    location_same_host: locationSameHost(response, target),
    response_content_type: contentType(response),
    response_bytes: response.body.length,
    elapsed_ms: elapsedMs,
  };
}

const isCliEntry = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (isCliEntry) {
  const deps: ProbeDependencies = {
    loadTarget,
    createQuery: () => createQuery(loadToken()),
    lineRequest: exactHttpsRequest,
    utageRequest: exactHttpsRequest,
    now: Date.now,
  };
  run(argv.slice(2), deps)
    .then((result) => stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const reason = error instanceof UtageProbeStop ? error.code : 'provider_or_local_error';
      stdout.write(`${JSON.stringify({ status: 'stopped', stop_reason: reason })}\n`);
      exit(1);
    });
}
