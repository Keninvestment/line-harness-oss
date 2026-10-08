import { describe, expect, it, vi } from 'vitest';
import { PoolRemovalStop, run } from './remove-from-pools-3841.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const pools = [
  { id: 'pool-1', activeAccountId: 'other-1' },
  { id: 'pool-2', activeAccountId: 'other-2' },
];

describe('#3841 traffic-pool removal', () => {
  it('deletes every membership by pool_accounts row id and verifies none remain', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: pools }))
      .mockResolvedValueOnce(json({ success: true, data: [
        { id: 'membership-1', poolId: 'pool-1', lineAccountId: 'acc-1', isActive: true },
      ] }))
      .mockResolvedValueOnce(json({ success: true, data: [
        { id: 'membership-2', poolId: 'pool-2', lineAccountId: 'acc-1', isActive: false },
      ] }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({ success: true, data: [] }))
      .mockResolvedValueOnce(json({ success: true, data: [] }));

    await expect(run(['acc-1'], { apiKey: 'top-secret', request }))
      .resolves.toEqual({ account_id: 'acc-1', removed: 2, remaining: 0 });
    expect(request).toHaveBeenCalledTimes(7);
    expect(request.mock.calls.map((call) => [call[1].method, call[0]])).toEqual([
      ['GET', expect.stringMatching(/\/api\/traffic-pools$/)],
      ['GET', expect.stringMatching(/\/api\/traffic-pools\/pool-1\/accounts$/)],
      ['GET', expect.stringMatching(/\/api\/traffic-pools\/pool-2\/accounts$/)],
      ['DELETE', expect.stringMatching(/\/pool-1\/accounts\/membership-1$/)],
      ['DELETE', expect.stringMatching(/\/pool-2\/accounts\/membership-2$/)],
      ['GET', expect.stringMatching(/\/api\/traffic-pools\/pool-1\/accounts$/)],
      ['GET', expect.stringMatching(/\/api\/traffic-pools\/pool-2\/accounts$/)],
    ]);
    expect(JSON.stringify(await runWithNoPools())).not.toContain('top-secret');
  });

  it('stops before listing memberships or deleting when target is a pool default', async () => {
    const request = vi.fn().mockResolvedValueOnce(json({ success: true, data: [
      { id: 'pool-1', activeAccountId: 'acc-1' },
    ] }));
    await expect(run(['acc-1'], { apiKey: 'secret', request }))
      .rejects.toMatchObject({ code: 'pool_default_account' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('re-lists pools even when there is no target membership', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: [pools[0]] }))
      .mockResolvedValueOnce(json({ success: true, data: [] }))
      .mockResolvedValueOnce(json({ success: true, data: [] }));
    await expect(run(['acc-1'], { apiKey: 'secret', request }))
      .resolves.toEqual({ account_id: 'acc-1', removed: 0, remaining: 0 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('stops on failed delete without retry', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: [pools[0]] }))
      .mockResolvedValueOnce(json({ success: true, data: [
        { id: 'membership-1', poolId: 'pool-1', lineAccountId: 'acc-1' },
      ] }))
      .mockResolvedValueOnce(json({ success: false, error: 'failed' }, 500));
    await expect(run(['acc-1'], { apiKey: 'secret', request }))
      .rejects.toMatchObject({ code: 'api_response' });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('fails if readback still has a target membership', async () => {
    const membership = { id: 'membership-1', poolId: 'pool-1', lineAccountId: 'acc-1' };
    const request = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: [pools[0]] }))
      .mockResolvedValueOnce(json({ success: true, data: [membership] }))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({ success: true, data: [membership] }));
    await expect(run(['acc-1'], { apiKey: 'secret', request }))
      .rejects.toMatchObject({ code: 'readback_mismatch' });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('rejects invalid arguments before any request', async () => {
    const request = vi.fn();
    await expect(run(['bad/id'], { apiKey: 'secret', request })).rejects.toBeInstanceOf(PoolRemovalStop);
    expect(request).not.toHaveBeenCalled();
  });
});

async function runWithNoPools(): Promise<Record<string, unknown>> {
  const request = vi.fn().mockResolvedValueOnce(json({ success: true, data: [] }));
  return run(['acc-1'], { apiKey: 'secret', request });
}
