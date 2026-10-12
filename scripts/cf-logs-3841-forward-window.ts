#!/usr/bin/env tsx
/** Read-only, aggregate-only Cloudflare Workers log check for #3841. */

import { argv, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  exactHttpsRequest, loadToken, type ExactRequest, type HttpResponse,
} from './worker-b1-deploy-5229.js';

const ACCOUNT_ID = '67907592fdf596376bc2097e14a6563a';
const SCRIPT_NAME = 'line-harness';
const SETTINGS_PATH = `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/settings`;
export const TELEMETRY_QUERY_PATH =
  `/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_API_CALLS = 5;
const MAX_WINDOW_MS = 2 * 60 * 60 * 1000;
const RAW_FORWARD_FAILED = 'raw forwarding failed';
const RAW_FORWARD_LOOKUP_FAILED = 'raw forwarding lookup failed';
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type JsonObject = Record<string, unknown>;
export type CfRequest = (request: ExactRequest, expiresAt: number) => Promise<HttpResponse>;

export interface RunDependencies {
  token: string;
  request: CfRequest;
  now: () => number;
}

export class ForwardWindowStop extends Error {
  constructor(readonly code: string) { super(code); }
}

interface Window {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
}

interface Observability {
  enabled: boolean;
  head_sampling_rate: number;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

function topLevelKeys(value: unknown): string[] {
  const record = object(value);
  return record ? Object.keys(record).sort() : [];
}

function contentType(response: HttpResponse): string {
  const value = response.headers['content-type'];
  return (Array.isArray(value) ? value[0] : value)?.split(';', 1)[0].trim().toLowerCase() ?? '';
}

function parseJson(response: HttpResponse, code: string): unknown {
  if (response.status !== 200 || contentType(response) !== 'application/json') {
    throw new ForwardWindowStop(`${code}_response`);
  }
  try {
    return JSON.parse(response.body.toString('utf8')) as unknown;
  } catch {
    throw new ForwardWindowStop(`${code}_json`);
  }
}

export function parseWindow(raw: string[]): Window {
  if (raw.length !== 4 || raw[0] !== '--from' || raw[2] !== '--to') {
    throw new ForwardWindowStop('arguments');
  }
  if (!ISO_TIMESTAMP.test(raw[1]) || !ISO_TIMESTAMP.test(raw[3])) {
    throw new ForwardWindowStop('window');
  }
  const fromMs = Date.parse(raw[1]);
  const toMs = Date.parse(raw[3]);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs ||
      toMs - fromMs > MAX_WINDOW_MS) {
    throw new ForwardWindowStop('window');
  }
  return {
    from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), fromMs, toMs,
  };
}

export function assertTelemetryQueryPath(path: string): void {
  if (path !== TELEMETRY_QUERY_PATH) throw new ForwardWindowStop('telemetry_query_path');
}

function shapeUnrecognized(value: unknown, observability?: Observability): Record<string, unknown> {
  return {
    ...(observability ? { observability } : {}),
    shape_unrecognized: true,
    top_level_keys: topLevelKeys(value),
  };
}

function parseObservability(value: unknown): Observability | null {
  const envelope = object(value);
  const result = object(envelope?.result);
  const observability = object(result?.observability);
  if (envelope?.success !== true || typeof observability?.enabled !== 'boolean' ||
      typeof observability.head_sampling_rate !== 'number' ||
      !Number.isFinite(observability.head_sampling_rate) || observability.head_sampling_rate < 0 ||
      observability.head_sampling_rate > 1) return null;
  return {
    enabled: observability.enabled,
    head_sampling_rate: observability.head_sampling_rate,
  };
}

function parseSource(event: JsonObject): JsonObject {
  const source = object(event.source);
  if (source) return source;
  if (typeof event.source === 'string') {
    try { return object(JSON.parse(event.source) as unknown) ?? event; } catch { return event; }
  }
  return event;
}

function nested(record: JsonObject, ...keys: string[]): unknown {
  let value: unknown = record;
  for (const key of keys) {
    const current = object(value);
    if (!current) return undefined;
    value = current[key];
  }
  return value;
}

function requestPath(event: JsonObject, source: JsonObject): string | null {
  const candidates = [
    nested(source, 'event', 'request', 'url'), nested(source, 'event', 'request', 'path'),
    nested(source, 'request', 'url'), nested(source, 'request', 'path'),
    nested(event, 'event', 'request', 'url'), nested(event, 'event', 'request', 'path'),
    nested(event, 'request', 'url'), nested(event, 'request', 'path'),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try { return new URL(candidate, 'https://invalid.local').pathname; } catch { /* try next */ }
  }
  return null;
}

function timestampMs(event: JsonObject, source: JsonObject): number | null {
  const candidates = [event.timestamp, source.timestamp, nested(event, '$metadata', 'timestamp'),
    nested(source, '$metadata', 'timestamp')];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate < 10_000_000_000 ? candidate * 1000 : candidate;
    }
    if (typeof candidate === 'string') {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function messageContains(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => messageContains(item, needle));
  const record = object(value);
  return record ? Object.values(record).some((item) => messageContains(item, needle)) : false;
}

function logs(event: JsonObject, source: JsonObject): unknown[] {
  if (Array.isArray(source.logs)) return source.logs;
  return Array.isArray(event.logs) ? event.logs : [];
}

function hasExceptionOrNonOk(event: JsonObject, source: JsonObject): boolean {
  const exceptions = Array.isArray(source.exceptions) ? source.exceptions :
    Array.isArray(event.exceptions) ? event.exceptions : [];
  const outcome = typeof source.outcome === 'string' ? source.outcome :
    typeof event.outcome === 'string' ? event.outcome : null;
  return exceptions.length > 0 || (outcome !== null && outcome !== 'ok');
}

function minuteKey(timestamp: number): string {
  return new Date(Math.floor(timestamp / 60_000) * 60_000).toISOString();
}

function emptyMinutes(window: Window): Record<string, number> {
  const result: Record<string, number> = {};
  let minute = Math.floor(window.fromMs / 60_000) * 60_000;
  while (minute < window.toMs) {
    result[new Date(minute).toISOString()] = 0;
    minute += 60_000;
  }
  return result;
}

function aggregateEvents(events: unknown[], window: Window): Record<string, unknown> | null {
  const perMinute = emptyMinutes(window);
  let webhookInvocations = 0;
  let rawForwardingFailed = 0;
  let rawForwardingLookupFailed = 0;
  let exceptionOrNonOk = 0;

  for (const item of events) {
    const event = object(item);
    if (!event) return null;
    const source = parseSource(event);
    const isWebhook = requestPath(event, source) === '/webhook';
    if (isWebhook) {
      const timestamp = timestampMs(event, source);
      if (timestamp === null || timestamp < window.fromMs || timestamp >= window.toMs) return null;
      webhookInvocations += 1;
      const key = minuteKey(timestamp);
      if (!(key in perMinute)) return null;
      perMinute[key] += 1;
    }
    for (const entry of logs(event, source)) {
      const message = object(entry)?.message ?? entry;
      if (messageContains(message, RAW_FORWARD_FAILED)) rawForwardingFailed += 1;
      if (messageContains(message, RAW_FORWARD_LOOKUP_FAILED)) rawForwardingLookupFailed += 1;
    }
    if (hasExceptionOrNonOk(event, source)) exceptionOrNonOk += 1;
  }

  return {
    webhook_invocations: webhookInvocations,
    raw_forwarding_failed_log_lines: rawForwardingFailed,
    raw_forwarding_lookup_failed_log_lines: rawForwardingLookupFailed,
    exception_or_non_ok_invocations: exceptionOrNonOk,
    webhook_invocations_per_minute: perMinute,
  };
}

function telemetryBody(window: Window): Buffer {
  return Buffer.from(JSON.stringify({
    queryId: '3841-forward-window',
    view: 'events',
    timeframe: { from: window.fromMs, to: window.toMs },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: SCRIPT_NAME }],
      limit: 10_000,
    },
  }), 'utf8');
}

export async function run(raw: string[], deps: RunDependencies): Promise<Record<string, unknown>> {
  const window = parseWindow(raw);
  let apiCalls = 0;
  const call = async (request: ExactRequest): Promise<HttpResponse> => {
    apiCalls += 1;
    if (apiCalls > MAX_API_CALLS) throw new ForwardWindowStop('api_call_limit');
    return deps.request(request, deps.now() + REQUEST_TIMEOUT_MS);
  };
  const auth = { Authorization: `Bearer ${deps.token}`, 'Accept-Encoding': 'identity' };
  const settingsValue = parseJson(await call({
    hostname: 'api.cloudflare.com', method: 'GET', path: SETTINGS_PATH,
    headers: auth, maxBytes: MAX_RESPONSE_BYTES,
  }), 'settings');
  const observability = parseObservability(settingsValue);
  if (!observability) return shapeUnrecognized(settingsValue);
  if (!observability.enabled) return { observability, logs_unavailable: true };

  const path = TELEMETRY_QUERY_PATH;
  assertTelemetryQueryPath(path);
  const body = telemetryBody(window);
  const telemetryValue = parseJson(await call({
    hostname: 'api.cloudflare.com', method: 'POST', path,
    headers: {
      ...auth, 'Content-Type': 'application/json', 'Content-Length': body.length,
    },
    body, maxBytes: MAX_RESPONSE_BYTES,
  }), 'telemetry');
  const envelope = object(telemetryValue);
  const result = object(envelope?.result);
  if (envelope?.success !== true || !Array.isArray(result?.events)) {
    return shapeUnrecognized(telemetryValue, observability);
  }
  const aggregates = aggregateEvents(result.events, window);
  if (!aggregates) return shapeUnrecognized(telemetryValue, observability);
  return { observability, ...aggregates };
}

const isCliEntry = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (isCliEntry) {
  run(argv.slice(2), { token: loadToken(), request: exactHttpsRequest, now: Date.now })
    .then((result) => stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const reason = error instanceof ForwardWindowStop ? error.code : 'provider_or_local_error';
      stdout.write(`${JSON.stringify({ status: 'stopped', stop_reason: reason })}\n`);
      exit(1);
    });
}
