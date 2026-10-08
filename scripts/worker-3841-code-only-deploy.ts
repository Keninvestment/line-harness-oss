#!/usr/bin/env tsx
/** Bounded code-only deploy/rollback tooling for #3841. */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, env, exit, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  exactHttpsRequest, getSnapshot, loadToken,
  type ExactRequest, type HttpResponse, type WorkerSnapshot,
} from './worker-b1-deploy-5229.js';
import { canonical } from './worker-b1-v1-postdeploy-readback-5229.js';

const ACCOUNT_ID = '67907592fdf596376bc2097e14a6563a';
const SCRIPT_NAME = 'line-harness';
const WORKER_HOST = 'line-harness.family8office.workers.dev';
const ARTIFACT_WORKTREE = '/Users/kensmba/.line-harness-wt/3841-v019-artifact';
const ARTIFACT_HEAD = 'bd2ca007e1222f8a3ec9b98a90a1a518e27a6140';
const TARGET_VERSION = '0.19.0-3841.fwd.bd2ca00';
const CURRENT_VERSION = '0.19.0-5229.b4.ac10457';
const CURRENT_WORKER_HASH = 'sha256:45aa5132adffe83e1710534efd914b116cb6a4d06df0926df4b28b71f9f51bf2';
const CURRENT_DEPLOYMENT_ID = '77264a6e-fecd-4717-9811-6be51faeaa3b';
const CURRENT_VERSION_ID = '92f245da-84a7-41b1-ab10-845cab9947d0';
const ADMIN_NAME_SHA256 = '492123998ae432be97e93235fce10a2d5d118fd9eb8be802edd46ae8345ca9a2';
const ZERO_HASH = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const MAX_BYTES = 262_144;
const BOUNDARY = '----line-harness-3841-code-only';

type Runtime = { version: string; worker_hash: string; released_at?: string };
type Artifact = { bytes: Buffer; sha256: string; size: number; workerHash: string; date: string };

export class Deploy3841Stop extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface Dependencies {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  token: () => string;
  artifact: (date: string) => Artifact;
  snapshot: (token: string, expiresAt: number, request: (spec: ExactRequest) => Promise<HttpResponse>) => Promise<WorkerSnapshot>;
  cfRequest: (spec: ExactRequest, expiresAt: number) => Promise<HttpResponse>;
  workerRequest: (spec: ExactRequest, expiresAt: number) => Promise<HttpResponse>;
  writeSummary: (date: string, value: unknown) => void;
}

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

function dateTokyo(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce<Record<string, string>>((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}${parts.month}${parts.day}`;
}

function artifactDirs(date: string): [string, string] {
  return [`/Users/kensmba/.line-harness-3841-BUILD-${date}-final1`, `/Users/kensmba/.line-harness-3841-BUILD-${date}-final2`];
}

function git(args: string[]): Buffer {
  try { return execFileSync('git', ['-C', ARTIFACT_WORKTREE, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024,
  }); }
  catch { throw new Deploy3841Stop('artifact_git'); }
}

function verifyArtifactTree(): string {
  if (git(['rev-parse', 'HEAD']).toString('utf8').trim() !== ARTIFACT_HEAD) throw new Deploy3841Stop('artifact_head');
  if (git(['status', '--porcelain=v1', '--untracked-files=all']).toString('utf8').trim() !== '') {
    throw new Deploy3841Stop('artifact_dirty');
  }
  return git(['show', '-s', '--format=%cI', 'HEAD']).toString('utf8').trim();
}

function versionSource(workerHash: string, releasedAt: string): string {
  return `// AUTO-GENERATED for #3841 deterministic deploy.\n` +
    `export const BUNDLE_VERSION = ${JSON.stringify(TARGET_VERSION)};\n` +
    `export const WORKER_HASH = ${JSON.stringify(workerHash)};\n` +
    `export const ADMIN_HASH = ${JSON.stringify(ZERO_HASH)};\n` +
    `export const LIFF_HASH = ${JSON.stringify(ZERO_HASH)};\n` +
    `export const RELEASED_AT = ${JSON.stringify(releasedAt)};\n`;
}

function buildOne(outputDir: string, releasedAt: string): { final: Buffer; workerHash: string } {
  if (existsSync(outputDir)) throw new Deploy3841Stop('build_output_exists');
  const scratch = mkdtempSync(join(tmpdir(), 'line-harness-3841-build-'));
  let stage = 'archive';
  try {
    chmodSync(scratch, 0o700);
    const archive = git(['archive', '--format=tar', ARTIFACT_HEAD]);
    execFileSync('tar', ['-xf', '-', '-C', scratch], { input: archive, stdio: ['pipe', 'ignore', 'ignore'] });
    stage = 'dependencies';
    symlinkSync(`${ARTIFACT_WORKTREE}/node_modules`, `${scratch}/node_modules`, 'dir');
    const originalWorkerModules = `${ARTIFACT_WORKTREE}/apps/worker/node_modules`;
    const scratchWorkerModules = `${scratch}/apps/worker/node_modules`;
    mkdirSync(scratchWorkerModules, { mode: 0o700 });
    for (const name of readdirSync(originalWorkerModules)) {
      if (name === '@line-crm' || name === '@line-harness') continue;
      symlinkSync(`${originalWorkerModules}/${name}`, `${scratchWorkerModules}/${name}`, 'dir');
    }
    mkdirSync(`${scratchWorkerModules}/@line-crm`, { mode: 0o700 });
    for (const name of ['db', 'line-sdk', 'shared']) {
      symlinkSync(`${scratch}/packages/${name}`, `${scratchWorkerModules}/@line-crm/${name}`, 'dir');
    }
    mkdirSync(`${scratchWorkerModules}/@line-harness`, { mode: 0o700 });
    symlinkSync(`${scratch}/packages/update-engine`, `${scratchWorkerModules}/@line-harness/update-engine`, 'dir');
    for (const workspacePackage of ['shared', 'line-sdk', 'update-engine']) {
      symlinkSync(`${ARTIFACT_WORKTREE}/packages/${workspacePackage}/node_modules`,
        `${scratch}/packages/${workspacePackage}/node_modules`, 'dir');
    }
    const tsc = `${ARTIFACT_WORKTREE}/node_modules/.bin/tsc`;
    execFileSync(tsc, ['-p', 'packages/shared/tsconfig.build.json'], { cwd: scratch, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync(tsc, ['-p', 'packages/line-sdk/tsconfig.build.json'], { cwd: scratch, stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync(`${ARTIFACT_WORKTREE}/packages/update-engine/node_modules/.bin/tsup`, [], {
      cwd: `${scratch}/packages/update-engine`, stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('node', ['scripts/preserve-node-builtins.mjs'], {
      cwd: `${scratch}/packages/update-engine`, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const config = `${scratch}/apps/worker/wrangler.3841.toml`;
    writeFileSync(config, 'name = "line-harness"\nmain = "src/index.ts"\ncompatibility_date = "2024-12-01"\ncompatibility_flags = ["nodejs_compat"]\n', { mode: 0o600 });
    stage = 'first_pass';
    const wrangler = `${ARTIFACT_WORKTREE}/node_modules/.bin/wrangler`;
    const buildEnv = { ...env, WRANGLER_LOG_PATH: `${scratch}/wrangler.log` };
    execFileSync(wrangler, ['deploy', '--dry-run', '--config', 'wrangler.3841.toml', '--outdir', 'dist-3841-first'], { cwd: `${scratch}/apps/worker`, env: buildEnv, stdio: ['ignore', 'ignore', 'ignore'] });
    const first = readFileSync(`${scratch}/apps/worker/dist-3841-first/index.js`);
    const workerHash = `sha256:${sha256(first)}`;
    stage = 'stamp';
    writeFileSync(`${scratch}/apps/worker/src/_version.ts`, versionSource(workerHash, releasedAt), { mode: 0o600 });
    stage = 'final_pass';
    execFileSync(wrangler, ['deploy', '--dry-run', '--config', 'wrangler.3841.toml', '--outdir', outputDir], { cwd: `${scratch}/apps/worker`, env: buildEnv, stdio: ['ignore', 'ignore', 'ignore'] });
    chmodSync(outputDir, 0o700);
    const file = `${outputDir}/index.js`;
    stage = 'readback';
    chmodSync(file, 0o600);
    return { final: readFileSync(file), workerHash };
  } catch (error) {
    if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
    if (error instanceof Deploy3841Stop) throw error;
    throw new Deploy3841Stop(`artifact_build_${stage}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function build(date = dateTokyo(), outputDirs = artifactDirs(date)): Record<string, unknown> {
  const releasedAt = verifyArtifactTree();
  const [firstDir, secondDir] = outputDirs;
  const first = buildOne(firstDir, releasedAt);
  let second: { final: Buffer; workerHash: string };
  try { second = buildOne(secondDir, releasedAt); }
  catch (error) { throw error; }
  if (!first.final.equals(second.final) || first.workerHash !== second.workerHash) throw new Deploy3841Stop('double_build_mismatch');
  const metadata = {
    source_head: ARTIFACT_HEAD, version: TARGET_VERSION, worker_hash: first.workerHash,
    sha256: sha256(first.final), bytes: first.final.length, released_at: releasedAt, builds_equal: true,
  };
  for (const dir of [firstDir, secondDir]) {
    writeFileSync(`${dir}/artifact-metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  return metadata;
}

function loadBuiltArtifact(date: string): Artifact {
  const [firstDir, secondDir] = artifactDirs(date);
  for (const dir of [firstDir, secondDir]) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new Deploy3841Stop('artifact_directory');
  }
  const firstFile = `${firstDir}/index.js`;
  const secondFile = `${secondDir}/index.js`;
  const firstMeta = `${firstDir}/artifact-metadata.json`;
  const secondMeta = `${secondDir}/artifact-metadata.json`;
  for (const path of [firstFile, secondFile, firstMeta, secondMeta]) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Deploy3841Stop('artifact_file');
    }
  }
  const first = readFileSync(firstFile);
  const second = readFileSync(secondFile);
  const firstMetaBytes = readFileSync(firstMeta);
  const secondMetaBytes = readFileSync(secondMeta);
  const meta = JSON.parse(firstMetaBytes.toString('utf8')) as Record<string, unknown>;
  if (!first.equals(second) || meta.source_head !== ARTIFACT_HEAD || meta.version !== TARGET_VERSION ||
      !firstMetaBytes.equals(secondMetaBytes) ||
      meta.sha256 !== sha256(first) || meta.bytes !== first.length || typeof meta.worker_hash !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(meta.worker_hash) || !first.includes(Buffer.from(TARGET_VERSION)) ||
      !first.includes(Buffer.from(meta.worker_hash.slice(7)))) throw new Deploy3841Stop('artifact_identity');
  return { bytes: first, sha256: meta.sha256, size: first.length, workerHash: meta.worker_hash, date } as Artifact;
}

function header(response: HttpResponse, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value;
}

function parseJson(response: HttpResponse): Record<string, unknown> {
  if (response.status !== 200 || !header(response, 'content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Deploy3841Stop('http_response');
  }
  try { return JSON.parse(response.body.toString('utf8')) as Record<string, unknown>; }
  catch { throw new Deploy3841Stop('response_json'); }
}

function runtime(response: HttpResponse): Runtime {
  const value = parseJson(response);
  if (typeof value.version !== 'string' || typeof value.worker_hash !== 'string') throw new Deploy3841Stop('runtime_shape');
  return value as Runtime;
}

export function validateApproval(rawId: string | undefined, expires: string | undefined, kind: 'D1' | 'RB', now: number): string {
  const match = new RegExp(`^3841-${kind}-([0-9]{8})$`).exec(rawId ?? '');
  const end = Date.parse(expires ?? '');
  if (!match || !Number.isFinite(end)) throw new Deploy3841Stop('approval_arguments');
  if (now > end || end > now + 7_200_000) throw new Deploy3841Stop('approval_expired_or_too_long');
  return match[1];
}

function projection(snapshot: WorkerSnapshot): unknown {
  const settings = snapshot.settings as Record<string, unknown>;
  return {
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    cache_options: settings.cache_options ?? null,
    binding_shape: snapshot.bindingShape,
    subdomain_sha256: snapshot.subdomainSha256,
    schedules_sha256: snapshot.schedulesSha256,
    version_asset_sha256: snapshot.versionAssetBindingDigest,
    settings_asset_sha256: snapshot.settingsAssetBindingDigest,
    admin_project_sha256: snapshot.adminProjectNameSha256,
    admin_deployment_id: snapshot.adminDeploymentId,
  };
}

function sanitizedSnapshot(snapshot: WorkerSnapshot): Record<string, unknown> {
  return {
    deployment_id: snapshot.deploymentId, version_id: snapshot.versionId, script_etag: snapshot.scriptEtag,
    settings_sha256: snapshot.settingsSha256, binding_count: snapshot.bindingShape.length,
    subdomain_sha256: snapshot.subdomainSha256, schedules_sha256: snapshot.schedulesSha256,
    version_asset_sha256: snapshot.versionAssetBindingDigest, settings_asset_sha256: snapshot.settingsAssetBindingDigest,
    admin_project_sha256: snapshot.adminProjectNameSha256, admin_deployment_id: snapshot.adminDeploymentId,
  };
}

function validateCurrent(snapshot: WorkerSnapshot, observed: Runtime): void {
  if (snapshot.deploymentId !== CURRENT_DEPLOYMENT_ID || snapshot.versionId !== CURRENT_VERSION_ID ||
      observed.version !== CURRENT_VERSION || observed.worker_hash !== CURRENT_WORKER_HASH) {
    throw new Deploy3841Stop('production_drift');
  }
}

export function buildContentUpload(artifact: Buffer): Buffer {
  if (artifact.includes(Buffer.from(BOUNDARY))) throw new Deploy3841Stop('boundary_collision');
  const before = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{"main_module":"worker.js"}\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n`);
  return Buffer.concat([before, artifact, Buffer.from(`\r\n--${BOUNDARY}--\r\n`)]);
}

function envelopeOk(response: HttpResponse): void {
  const value = parseJson(response);
  if (value.success !== true) throw new Deploy3841Stop('provider_rejected');
}

async function getRuntime(deps: Dependencies, expiresAt: number): Promise<Runtime> {
  return runtime(await deps.workerRequest({ hostname: WORKER_HOST, method: 'GET', path: '/admin/version',
    headers: { 'Accept-Encoding': 'identity' }, maxBytes: 8_192 }, expiresAt));
}

async function preflight(deps: Dependencies, expiresAt: number): Promise<{ snapshot: WorkerSnapshot; runtime: Runtime; token: string }> {
  const token = deps.token();
  const request = (spec: ExactRequest) => deps.cfRequest(spec, expiresAt);
  const snapshot = await deps.snapshot(token, expiresAt, request);
  const observed = await getRuntime(deps, expiresAt);
  validateCurrent(snapshot, observed);
  return { snapshot, runtime: observed, token };
}

export async function run(raw: string[], deps: Dependencies): Promise<Record<string, unknown>> {
  const command = raw[0];
  if (command === 'preflight' && raw.length === 1) {
    const result = await preflight(deps, deps.now() + 60_000);
    return { command, status: 'PASS', production: { version: result.runtime.version, worker_hash: result.runtime.worker_hash },
      snapshot: sanitizedSnapshot(result.snapshot), provider_writes: 0 };
  }
  if ((command !== 'apply' && command !== 'rollback') || raw[1] !== '--approval-id' || raw[3] !== '--expires' || raw.length !== 5) {
    throw new Deploy3841Stop('arguments');
  }
  const kind = command === 'apply' ? 'D1' : 'RB';
  const date = validateApproval(raw[2], raw[4], kind, deps.now());
  const expiresAt = Date.parse(raw[4]);
  if (command === 'rollback') {
    const token = deps.token();
    const body = Buffer.from(JSON.stringify({ strategy: 'percentage', versions: [{ version_id: CURRENT_VERSION_ID, percentage: 100 }] }));
    const response = await deps.cfRequest({ hostname: 'api.cloudflare.com', method: 'POST',
      path: `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/deployments`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', 'Content-Length': body.length },
      body, maxBytes: MAX_BYTES }, expiresAt);
    envelopeOk(response);
    let observed: Runtime | null = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      observed = await getRuntime(deps, expiresAt);
      if (observed.version === CURRENT_VERSION && observed.worker_hash === CURRENT_WORKER_HASH) break;
      if (attempt < 11) await deps.sleep(2_000);
    }
    if (!observed || observed.version !== CURRENT_VERSION || observed.worker_hash !== CURRENT_WORKER_HASH) {
      throw new Deploy3841Stop('rollback_propagation_timeout');
    }
    return { command, approval_id: raw[2], status: 'completed', deployment_post_attempts: 1,
      version_id: CURRENT_VERSION_ID, runtime: { version: observed.version, worker_hash: observed.worker_hash } };
  }

  const artifact = deps.artifact(date);
  let putAttempts = 0;
  let mutationOutcome: 'not_attempted' | 'unknown' | 'accepted' = 'not_attempted';
  let before: WorkerSnapshot | null = null;
  try {
    const initial = await preflight(deps, expiresAt);
    before = initial.snapshot;
    const auth = { Authorization: `Bearer ${initial.token}`, 'Accept-Encoding': 'identity' };
    const finalPre = await deps.snapshot(initial.token, expiresAt, (spec) => deps.cfRequest(spec, expiresAt));
    if (canonical(before) !== canonical(finalPre)) throw new Deploy3841Stop('pre_put_snapshot_drift');
    const upload = buildContentUpload(artifact.bytes);
    putAttempts = 1; mutationOutcome = 'unknown';
    envelopeOk(await deps.cfRequest({ hostname: 'api.cloudflare.com', method: 'PUT',
      path: `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT_NAME}/content`,
      headers: { ...auth, 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`, 'Content-Length': upload.length },
      body: upload, maxBytes: MAX_BYTES }, expiresAt));
    mutationOutcome = 'accepted';
    const after = await deps.snapshot(initial.token, expiresAt, (spec) => deps.cfRequest(spec, expiresAt));
    if (after.deploymentId === before.deploymentId || after.versionId === before.versionId ||
        after.scriptEtag === before.scriptEtag || canonical(projection(after)) !== canonical(projection(before))) {
      throw new Deploy3841Stop('post_write_config_mismatch');
    }
    let observed: Runtime | null = null;
    let attempts = 0;
    for (attempts = 1; attempts <= 12; attempts += 1) {
      observed = await getRuntime(deps, expiresAt);
      if (observed.version === TARGET_VERSION && observed.worker_hash === artifact.workerHash) break;
      if (attempts < 12) await deps.sleep(2_000);
    }
    if (!observed || observed.version !== TARGET_VERSION || observed.worker_hash !== artifact.workerHash) {
      throw new Deploy3841Stop('runtime_propagation_timeout');
    }
    const summary = {
      command, approval_id: raw[2], status: 'completed', artifact: { sha256: artifact.sha256, bytes: artifact.size,
        version: TARGET_VERSION, worker_hash: artifact.workerHash },
      before: sanitizedSnapshot(before), after: sanitizedSnapshot(after),
      runtime: { version: observed.version, worker_hash: observed.worker_hash, attempts },
      mutation: { outcome: mutationOutcome, put_attempts: putAttempts, retry: 0, redirect: 0,
        automatic_rollback: 0, reconciliation_required: false },
    };
    deps.writeSummary(date, summary); return summary;
  } catch (error) {
    if (putAttempts > 0) deps.writeSummary(date, {
      command, approval_id: raw[2], status: 'stopped', stop_reason: error instanceof Deploy3841Stop ? error.code : 'provider_or_local_error',
      artifact: { sha256: artifact.sha256, bytes: artifact.size, version: TARGET_VERSION, worker_hash: artifact.workerHash },
      before: before ? sanitizedSnapshot(before) : null,
      mutation: { outcome: mutationOutcome, put_attempts: putAttempts, retry: 0, redirect: 0,
        automatic_rollback: 0, reconciliation_required: true },
    });
    throw error;
  }
}

function writeSummary(date: string, value: unknown): void {
  const dir = `/Users/kensmba/.line-harness-3841-D1-${date}`;
  if (existsSync(dir)) throw new Deploy3841Stop('summary_exists');
  mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700);
  writeFileSync(`${dir}/sanitized-summary.json`, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

const defaultDeps: Dependencies = {
  now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), token: loadToken,
  artifact: loadBuiltArtifact,
  snapshot: async (token, expiresAt, request) => (await getSnapshot(token, expiresAt, request, ADMIN_NAME_SHA256)).snapshot,
  cfRequest: exactHttpsRequest, workerRequest: exactHttpsRequest, writeSummary,
};

const isCliEntry = argv[1] && fileURLToPath(import.meta.url) === argv[1];
if (isCliEntry) {
  const command = argv[2];
  const work = command === 'build' ? Promise.resolve(build()) : run(argv.slice(2), defaultDeps);
  work.then((result) => stdout.write(`${JSON.stringify(result)}\n`)).catch((error: unknown) => {
    const reason = error instanceof Deploy3841Stop ? error.code : 'provider_or_local_error';
    stdout.write(`${JSON.stringify({ status: 'stopped', stop_reason: reason, retry: 0, automatic_rollback: 0 })}\n`); exit(1);
  });
}
