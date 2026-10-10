#!/usr/bin/env tsx
/** Approval-time setter for the per-account raw webhook forward destination. */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { argv, exit, stderr, stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const TOKEN_FILE = '/Users/kensmba/.line-harness/.env.local';
export const HARNESS_ORIGIN = 'https://line-harness.family8office.workers.dev';
const MAX_BYTES = 32_768;

export class ForwardUrlStop extends Error {
  constructor(readonly code: string) { super(code); }
}

export type Requester = (url: string, init: RequestInit) => Promise<Response>;

function assertProtectedFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new ForwardUrlStop('file_protection');
  }
}

export function parseHarnessApiKey(text: string): string {
  const values: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?LINE_HARNESS_API_KEY\s*=\s*(.*?)\s*$/.exec(raw);
    if (!match) continue;
    let value = match[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.push(value);
  }
  if (values.length !== 1 || !values[0] || /[\r\n\0]/.test(values[0])) throw new ForwardUrlStop('api_key');
  return values[0];
}

export function loadHarnessApiKey(): string {
  const fromEnv = process.env.LINE_HARNESS_API_KEY?.trim();
  if (fromEnv) return parseHarnessApiKey(`LINE_HARNESS_API_KEY=${fromEnv}`);
  assertProtectedFile(TOKEN_FILE);
  return parseHarnessApiKey(readFileSync(TOKEN_FILE, 'utf8'));
}

export function validateDestination(raw: string): { value: string; url: URL } {
  const value = raw.trim();
  let url: URL;
  try { url = new URL(value); } catch { throw new ForwardUrlStop('destination_url'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new ForwardUrlStop('destination_url');
  }
  return { value, url };
}

function readDestinationFromStdin(): string {
  const tty = Boolean(stdin.isTTY);
  if (tty) {
    stderr.write('Forward destination URL (input hidden; Ctrl-D to finish): ');
    execFileSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'inherit'] });
  }
  try { return readFileSync(0, 'utf8'); }
  finally {
    if (tty) {
      execFileSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'inherit'] });
      stderr.write('\n');
    }
  }
}

function responseJson(response: Response): Promise<unknown> {
  return response.arrayBuffer().then((bytes) => {
    if (bytes.byteLength > MAX_BYTES || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new ForwardUrlStop('response_shape');
    }
    try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
    catch { throw new ForwardUrlStop('response_json'); }
  });
}

export async function run(
  raw: string[],
  deps: { apiKey: string; request: Requester; readStdin: () => string; readFile: (path: string) => string },
): Promise<Record<string, unknown>> {
  const accountId = raw[0];
  if (!accountId || !/^[A-Za-z0-9_-]+$/.test(accountId)) throw new ForwardUrlStop('account_id');
  let clear = false;
  let input: string | null = null;
  if (raw.length === 2 && raw[1] === '--clear') clear = true;
  else if (raw.length === 3 && raw[1] === '--file') input = deps.readFile(raw[2]);
  else if (raw.length === 1) input = deps.readStdin();
  else throw new ForwardUrlStop('arguments');

  const endpoint = `${HARNESS_ORIGIN}/api/line-accounts/${encodeURIComponent(accountId)}/settings/forward-raw-url`;
  const headers = { Authorization: `Bearer ${deps.apiKey}`, 'Accept-Encoding': 'identity' };
  let destination: { value: string; url: URL } | null = null;
  if (!clear) destination = validateDestination(input ?? '');
  const mutation = await deps.request(endpoint, {
    method: clear ? 'DELETE' : 'PUT', redirect: 'error',
    headers: clear ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: clear ? undefined : JSON.stringify({ value: destination?.value }),
    signal: AbortSignal.timeout(30_000),
  });
  const mutationBody = await responseJson(mutation) as { success?: unknown };
  if (!mutation.ok || mutationBody.success !== true) throw new ForwardUrlStop('mutation_failed');

  const readback = await deps.request(endpoint, {
    method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(30_000),
  });
  const readbackBody = await responseJson(readback) as { success?: unknown; data?: unknown };
  const expected = destination?.value ?? null;
  if (!readback.ok || readbackBody.success !== true || readbackBody.data !== expected) {
    throw new ForwardUrlStop('readback_mismatch');
  }
  return {
    account_id: accountId, set: !clear,
    scheme: destination ? destination.url.protocol.slice(0, -1) : null,
    host: destination ? destination.url.host : null,
    path_sha256: destination
      ? createHash('sha256').update(`${destination.url.pathname}${destination.url.search}`).digest('hex') : null,
  };
}

function protectedInputFile(path: string): string {
  assertProtectedFile(path);
  return readFileSync(path, 'utf8');
}

const isCliEntry = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (isCliEntry) {
  let apiKey: string;
  try { apiKey = loadHarnessApiKey(); }
  catch (error) {
    const reason = error instanceof ForwardUrlStop ? error.code : 'local_error';
    stdout.write(`${JSON.stringify({ status: 'stopped', stop_reason: reason })}\n`); exit(1);
  }
  run(argv.slice(2), { apiKey, request: fetch, readStdin: readDestinationFromStdin, readFile: protectedInputFile })
    .then((result) => stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      const reason = error instanceof ForwardUrlStop ? error.code : 'provider_or_local_error';
      stdout.write(`${JSON.stringify({ status: 'stopped', stop_reason: reason })}\n`); exit(1);
    });
}
