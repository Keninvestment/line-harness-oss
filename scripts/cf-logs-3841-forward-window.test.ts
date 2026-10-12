import { describe, expect, it } from 'vitest';
import type { ExactRequest, HttpResponse } from './worker-b1-deploy-5229.js';
import {
  assertTelemetryQueryPath, ForwardWindowStop, run, TELEMETRY_QUERY_PATH, type CfRequest,
} from './cf-logs-3841-forward-window.js';

function response(result: unknown): HttpResponse {
  return {
    status: 200, headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify({ success: true, result }), 'utf8'),
  };
}

const ARGS = ['--from', '2026-10-12T06:01:28Z', '--to', '2026-10-12T06:09:30Z'];

describe('#3841 Cloudflare forward-window log check', () => {
  it('reports unavailable and makes no telemetry query when observability is disabled', async () => {
    const calls: ExactRequest[] = [];
    const request: CfRequest = async (spec) => {
      calls.push(spec);
      return response({ observability: { enabled: false, head_sampling_rate: 0 } });
    };
    const result = await run(ARGS, { token: 'secret-token', request, now: () => 0 });
    expect(result).toEqual({
      observability: { enabled: false, head_sampling_rate: 0 }, logs_unavailable: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('aggregates webhook invocations, fixed failure prefixes, errors, and minute buckets', async () => {
    const calls: ExactRequest[] = [];
    const request: CfRequest = async (spec) => {
      calls.push(spec);
      if (calls.length === 1) {
        return response({ observability: { enabled: true, head_sampling_rate: 1 } });
      }
      return response({ events: [
        {
          timestamp: '2026-10-12T06:01:29Z',
          source: {
            event: { request: { url: 'https://example.invalid/webhook?user=private-user' } },
            logs: [{ message: ['[webhook] raw forwarding failed after 3 attempts', 'private-body'] }],
            exceptions: [], outcome: 'ok', headers: { authorization: 'private-header' },
          },
        },
        {
          timestamp: 1_791_784_890_000,
          source: {
            event: { request: { url: 'https://example.invalid/webhook' } },
            logs: [{ message: '[webhook] raw forwarding lookup failed private-user' }],
            exceptions: [{ message: 'private-exception' }], outcome: 'exception',
          },
        },
        {
          timestamp: '2026-10-12T06:03:00Z',
          source: { event: { request: { url: 'https://example.invalid/health/private' } },
            logs: [], exceptions: [], outcome: 'exceededCpu' },
        },
      ] });
    };
    const result = await run(ARGS, { token: 'secret-token', request, now: () => 10 });
    expect(result).toMatchObject({
      observability: { enabled: true, head_sampling_rate: 1 },
      webhook_invocations: 2,
      raw_forwarding_failed_log_lines: 1,
      raw_forwarding_lookup_failed_log_lines: 1,
      exception_or_non_ok_invocations: 2,
    });
    const perMinute = result.webhook_invocations_per_minute as Record<string, number>;
    expect(perMinute['2026-10-12T06:01:00.000Z']).toBe(2);
    expect(perMinute['2026-10-12T06:02:00.000Z']).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].path).toBe(TELEMETRY_QUERY_PATH);
    expect(calls.every((call) => call.maxBytes === 2 * 1024 * 1024)).toBe(true);
    const body = JSON.parse(calls[1].body?.toString('utf8') ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ view: 'events', parameters: {
      datasets: ['cloudflare-workers'],
      filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: 'line-harness' }],
    } });
  });

  it('asserts the exact read-query endpoint', () => {
    expect(() => assertTelemetryQueryPath(TELEMETRY_QUERY_PATH)).not.toThrow();
    expect(() => assertTelemetryQueryPath(`${TELEMETRY_QUERY_PATH}/other`)).toThrow(ForwardWindowStop);
    expect(() => assertTelemetryQueryPath(
      '/client/v4/accounts/67907592fdf596376bc2097e14a6563a/workers/scripts/line-harness',
    )).toThrow(/telemetry_query_path/);
  });

  it('never returns token, request data, URLs, headers, user ids, or raw log text', async () => {
    const secretValues = ['TOKEN-DO-NOT-PRINT', 'private-user-id', 'private-body',
      'https://secret.invalid/webhook', 'Bearer private-header',
      '[webhook] raw forwarding failed after 3 attempts'];
    let call = 0;
    const request: CfRequest = async () => {
      call += 1;
      if (call === 1) return response({ observability: { enabled: true, head_sampling_rate: 0.25 } });
      return response({ events: [{
        timestamp: '2026-10-12T06:02:00Z',
        source: {
          event: { request: { url: 'https://secret.invalid/webhook', body: 'private-body',
            headers: { authorization: 'Bearer private-header' } } },
          logs: [{ message: ['[webhook] raw forwarding failed after 3 attempts', 'private-user-id'] }],
          outcome: 'ok', exceptions: [],
        },
      }] });
    };
    const result = await run(ARGS, { token: secretValues[0], request, now: () => 0 });
    const output = JSON.stringify(result);
    for (const secret of secretValues) expect(output).not.toContain(secret);
    expect(output).not.toContain('raw forwarding failed');
    expect(output).not.toContain('secret.invalid');
  });

  it('returns only top-level key names for an unrecognized telemetry shape', async () => {
    let call = 0;
    const request: CfRequest = async () => {
      call += 1;
      if (call === 1) return response({ observability: { enabled: true, head_sampling_rate: 1 } });
      return {
        status: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ success: true, result: { private_body: 'do-not-print' },
          errors: ['private-error'] }), 'utf8'),
      };
    };
    const result = await run(ARGS, { token: 'private-token', request, now: () => 0 });
    expect(result).toEqual({
      observability: { enabled: true, head_sampling_rate: 1 },
      shape_unrecognized: true,
      top_level_keys: ['errors', 'result', 'success'],
    });
    expect(JSON.stringify(result)).not.toContain('do-not-print');
    expect(JSON.stringify(result)).not.toContain('private-error');
  });
});
