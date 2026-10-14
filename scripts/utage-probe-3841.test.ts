import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExactRequest, HttpResponse } from './worker-b1-deploy-5229.js';
import {
  computeSignature, loadTarget, run, type ProbeDependencies,
} from './utage-probe-3841.js';

const USER_ID = 'U0123456789abcdef0123456789abcdef';
const SECRET = 'secret-never-print';
const TOKEN = 'token-never-print';
const TARGET_PATH = '/secret/webhook?key=path-never-print';
const BASE_ARGS = [
  '--channel-id', '1234567890', '--url-file', '/not/read/by/mock',
  '--approval-id', '3841-PR-20261015',
];
const temporaryDirectories: string[] = [];

function response(status: number, body: string, headers: HttpResponse['headers'] = {}): HttpResponse {
  return { status, headers, body: Buffer.from(body, 'utf8') };
}

function expectNoUserAgent(headers: ExactRequest['headers']): void {
  expect(Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent')).toBe(false);
}

function dependencies(
  utageResponse: HttpResponse = response(204, '', { 'content-type': 'application/json; charset=utf-8' }),
): {
  deps: ProbeDependencies;
  lineCalls: ExactRequest[];
  utageCalls: ExactRequest[];
  loadTargetMock: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
} {
  const lineCalls: ExactRequest[] = [];
  const utageCalls: ExactRequest[] = [];
  const loadTargetMock = vi.fn(() => ({
    hostname: 'hooks.utage-system.com', path: TARGET_PATH, pathSha256: 'a'.repeat(64),
  }));
  const query = vi.fn(async () => [{ channel_secret: SECRET, channel_access_token: TOKEN }]);
  const times = [1_000, 2_000, 2_037];
  const deps: ProbeDependencies = {
    loadTarget: loadTargetMock,
    createQuery: () => query,
    lineRequest: async (request) => {
      lineCalls.push(request);
      return response(200, JSON.stringify({ userId: USER_ID }), { 'content-type': 'application/json' });
    },
    utageRequest: async (request) => {
      utageCalls.push(request);
      return utageResponse;
    },
    now: () => times.shift() ?? 2_037,
  };
  return { deps, lineCalls, utageCalls, loadTargetMock, query };
}

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('UTAGE #3841 one-shot probe', () => {
  it('computes the LINE HMAC-SHA256 signature for a known vector', () => {
    const body = Buffer.from(`{"destination":"${USER_ID}","events":[]}`, 'utf8');
    expect(computeSignature('known-secret', body)).toBe('K2R9ypsLeEP2e0deiCN70pFu330UpTYhw8rTnEAHwo8=');
  });

  it('makes one D1 SELECT, one LINE GET, and exactly one non-following UTAGE POST', async () => {
    const redirect = response(302, 'never expose this response', {
      location: 'https://other.example/redirect-secret',
      'content-type': 'text/html; charset=utf-8',
    });
    const { deps, lineCalls, utageCalls, query } = dependencies(redirect);
    const result = await run(BASE_ARGS, deps);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      'SELECT channel_secret, channel_access_token FROM line_accounts WHERE channel_id = ? AND is_active = 1',
      ['1234567890'],
    );
    expect(lineCalls).toHaveLength(1);
    expect(lineCalls[0]).toMatchObject({
      hostname: 'api.line.me', method: 'GET', path: '/v2/bot/info',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(utageCalls).toHaveLength(1);
    expect(utageCalls[0]).toMatchObject({
      hostname: 'hooks.utage-system.com', method: 'POST', path: TARGET_PATH,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LineBotWebhook/2.0',
      },
    });
    const expectedBody = `{"destination":"${USER_ID}","events":[]}`;
    expect(utageCalls[0].body?.toString('utf8')).toBe(expectedBody);
    expect(utageCalls[0].headers['X-Line-Signature']).toBe(
      computeSignature(SECRET, Buffer.from(expectedBody, 'utf8')),
    );
    expect(result).toEqual({
      approval_id: '3841-PR-20261015', target: 'utage', user_agent_sent: true,
      host: 'hooks.utage-system.com', path_sha256: 'a'.repeat(64),
      destination_ok: true, status: 302, redirected: true, location_same_host: false,
      response_content_type: 'text/html', response_bytes: 26, elapsed_ms: 37,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [SECRET, TOKEN, USER_ID, TARGET_PATH, 'redirect-secret', 'never expose this response']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('uses a deliberately invalid signature in bad-signature mode with the same body', async () => {
    const { deps, utageCalls } = dependencies();
    await run([...BASE_ARGS, '--signature', 'bad'], deps);
    expect(utageCalls).toHaveLength(1);
    const body = utageCalls[0].body!;
    expect(body.toString('utf8')).toBe(`{"destination":"${USER_ID}","events":[]}`);
    expect(utageCalls[0].headers['X-Line-Signature']).not.toBe(computeSignature(SECRET, body));
  });

  it('sends no user-agent header in any casing in no-user-agent mode', async () => {
    const { deps, utageCalls } = dependencies();
    const result = await run([...BASE_ARGS, '--no-user-agent'], deps);

    expect(utageCalls).toHaveLength(1);
    expect(utageCalls[0]).toMatchObject({
      hostname: 'hooks.utage-system.com', method: 'POST', path: TARGET_PATH,
    });
    expectNoUserAgent(utageCalls[0].headers);
    expect(utageCalls[0].headers['X-Line-Signature']).toBe(
      computeSignature(SECRET, utageCalls[0].body!),
    );
    expect(result).toMatchObject({ target: 'utage', user_agent_sent: false });
  });

  it('sends exactly one correctly signed POST with only the two explicit headers via Harness', async () => {
    const { deps, utageCalls, loadTargetMock } = dependencies(response(200, 'ok'));
    const result = await run([...BASE_ARGS, '--via-harness'], deps);

    expect(loadTargetMock).toHaveBeenCalledTimes(1);
    expect(loadTargetMock).toHaveBeenCalledWith('/not/read/by/mock');
    expect(utageCalls).toHaveLength(1);
    const request = utageCalls[0];
    expect(request.hostname).toBe('line-harness.family8office.workers.dev');
    expect(request.path).toBe('/webhook');
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Line-Signature': computeSignature(SECRET, request.body!),
    });
    expectNoUserAgent(request.headers);
    expect(request.body?.toString('utf8')).toBe(`{"destination":"${USER_ID}","events":[]}`);
    expect(result).toMatchObject({
      target: 'harness', user_agent_sent: false, status: 200,
      host: 'hooks.utage-system.com', path_sha256: 'a'.repeat(64),
    });
  });

  it.each([
    ['--via-harness', '--signature', 'bad'],
    ['--via-harness', '--no-user-agent'],
  ])('rejects incompatible Harness mode arguments: %s', async (...extra) => {
    const { deps, lineCalls, utageCalls, loadTargetMock, query } = dependencies();
    await expect(run([...BASE_ARGS, ...extra], deps)).rejects.toMatchObject({ code: 'mode_conflict' });
    expect(loadTargetMock).toHaveBeenCalledTimes(0);
    expect(query).toHaveBeenCalledTimes(0);
    expect(lineCalls).toHaveLength(0);
    expect(utageCalls).toHaveLength(0);
  });

  it('stops on a URL file whose mode is not 0600', () => {
    const directory = mkdtempSync(join(tmpdir(), 'utage-probe-3841-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'target.txt');
    writeFileSync(path, 'https://hooks.utage-system.com/private', { mode: 0o600 });
    chmodSync(path, 0o644);
    expect(() => loadTarget(path)).toThrowError(expect.objectContaining({ code: 'url_file_mode' }));
  });

  it('stops when the hostname only contains, but is not within, utage-system.com', () => {
    const directory = mkdtempSync(join(tmpdir(), 'utage-probe-3841-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'target.txt');
    writeFileSync(path, 'https://evilutage-system.com/private', { mode: 0o600 });
    chmodSync(path, 0o600);
    expect(() => loadTarget(path)).toThrowError(expect.objectContaining({ code: 'url_host' }));
  });
});
