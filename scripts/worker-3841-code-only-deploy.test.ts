import { describe, expect, it, vi } from 'vitest';
import type { HttpResponse, WorkerSnapshot } from './worker-b1-deploy-5229.js';
import { buildContentUpload, run, validateApproval, Deploy3841Stop, type Dependencies } from './worker-3841-code-only-deploy.js';

const NOW = Date.parse('2026-10-08T01:00:00Z');
const EXPIRES = '2026-10-08T02:00:00Z';
const CURRENT_HASH = 'sha256:45aa5132adffe83e1710534efd914b116cb6a4d06df0926df4b28b71f9f51bf2';
const TARGET_HASH = `sha256:${'a'.repeat(64)}`;

function response(value: unknown): HttpResponse {
  return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(value)) };
}

function snapshot(overrides: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    deploymentId: '77264a6e-fecd-4717-9811-6be51faeaa3b', versionId: '92f245da-84a7-41b1-ab10-845cab9947d0',
    settings: { compatibility_date: '2024-12-01', compatibility_flags: ['nodejs_compat'] }, settingsSha256: 'settings',
    subdomain: { enabled: true }, subdomainSha256: 'subdomain', schedules: [], schedulesSha256: 'schedules',
    bindingShape: [{ name: 'DB', type: 'd1' }], scriptEtag: 'old-etag', versionAssetBindingDigest: 'assets',
    assetResourceIdentityAvailable: false, settingsAssetBindingDigest: 'assets', adminProjectNameSha256: 'admin',
    adminDeploymentId: 'admin-deployment', ...overrides,
  };
}

function deps(snapshots: WorkerSnapshot[], runtimes: Array<{ version: string; worker_hash: string }>) {
  const cfCalls: Array<{ method: string; path: string; body?: Buffer }> = [];
  const summaries: unknown[] = [];
  const value: Dependencies = {
    now: () => NOW, sleep: async () => undefined, token: () => 'secret-token',
    artifact: (date) => ({ bytes: Buffer.from(`bundle ${TARGET_HASH} 0.19.0-3841.fwd.bd2ca00`),
      sha256: 'artifact-sha', size: 80, workerHash: TARGET_HASH, date }),
    snapshot: async () => {
      const item = snapshots.shift(); if (!item) throw new Error('missing snapshot'); return item;
    },
    cfRequest: async (spec) => { cfCalls.push({ method: spec.method, path: spec.path, body: spec.body }); return response({ success: true, result: {} }); },
    workerRequest: async () => {
      const item = runtimes.shift(); if (!item) throw new Error('missing runtime'); return response(item);
    },
    writeSummary: (_date, summary) => { summaries.push(summary); },
  };
  return { value, cfCalls, summaries };
}

describe('#3841 bounded code-only deploy', () => {
  it('rejects expired and overlong approval windows', () => {
    expect(() => validateApproval('3841-D1-20261008', '2026-10-08T00:59:59Z', 'D1', NOW)).toThrow(Deploy3841Stop);
    expect(() => validateApproval('3841-D1-20261008', '2026-10-08T03:00:01Z', 'D1', NOW)).toThrow(Deploy3841Stop);
  });

  it('stops on immediate pre-PUT drift with zero writes', async () => {
    const d = deps([snapshot(), snapshot({ schedulesSha256: 'drift' })], [
      { version: '0.19.0-5229.b4.ac10457', worker_hash: CURRENT_HASH },
    ]);
    await expect(run(['apply', '--approval-id', '3841-D1-20261008', '--expires', EXPIRES], d.value))
      .rejects.toMatchObject({ code: 'pre_put_snapshot_drift' });
    expect(d.cfCalls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });

  it('performs exactly one content PUT on success', async () => {
    const before = snapshot();
    const after = snapshot({ deploymentId: 'new-deployment', versionId: 'new-version', scriptEtag: 'new-etag' });
    const d = deps([before, before, after], [
      { version: '0.19.0-5229.b4.ac10457', worker_hash: CURRENT_HASH },
      { version: '0.19.0-3841.fwd.bd2ca00', worker_hash: TARGET_HASH },
    ]);
    const result = await run(['apply', '--approval-id', '3841-D1-20261008', '--expires', EXPIRES], d.value);
    const puts = d.cfCalls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toContain('/content');
    expect(puts[0].body?.toString('utf8')).toContain('{"main_module":"worker.js"}');
    expect(result.status).toBe('completed');
  });

  it('marks reconciliation required after a post-write mismatch and does not retry', async () => {
    const before = snapshot();
    const after = snapshot({ deploymentId: 'new', versionId: 'new-v', scriptEtag: 'new-e', subdomainSha256: 'changed' });
    const d = deps([before, before, after], [{ version: '0.19.0-5229.b4.ac10457', worker_hash: CURRENT_HASH }]);
    await expect(run(['apply', '--approval-id', '3841-D1-20261008', '--expires', EXPIRES], d.value))
      .rejects.toMatchObject({ code: 'post_write_config_mismatch' });
    expect(d.cfCalls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(d.summaries).toHaveLength(1);
    expect(d.summaries[0]).toMatchObject({ mutation: { reconciliation_required: true, put_attempts: 1, retry: 0 } });
  });

  it('rollback makes exactly one deployments POST', async () => {
    const d = deps([], [{ version: '0.19.0-5229.b4.ac10457', worker_hash: CURRENT_HASH }]);
    const result = await run(['rollback', '--approval-id', '3841-RB-20261008', '--expires', EXPIRES], d.value);
    const posts = d.cfCalls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body!.toString('utf8'))).toEqual({ strategy: 'percentage', versions: [
      { version_id: '92f245da-84a7-41b1-ab10-845cab9947d0', percentage: 100 },
    ] });
    expect(result).toMatchObject({ status: 'completed', deployment_post_attempts: 1 });
  });

  it('multipart metadata contains main_module only', () => {
    const body = buildContentUpload(Buffer.from('bundle')).toString('utf8');
    const metadata = body.split('Content-Disposition: form-data; name="worker.js"')[0];
    expect(metadata).toContain('{"main_module":"worker.js"}');
    expect(metadata).not.toContain('bindings');
  });
});
