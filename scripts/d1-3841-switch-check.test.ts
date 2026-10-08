import { describe, expect, it } from 'vitest';
import { assertSingleSelect, normalizeSince, run, SwitchCheckStop, type Query } from './d1-3841-switch-check.js';

describe('D1 #3841 switch checks', () => {
  it('allows exactly one SELECT and rejects mutation or stacked SQL', () => {
    expect(() => assertSingleSelect('SELECT COUNT(*) FROM friends')).not.toThrow();
    expect(() => assertSingleSelect('DELETE FROM friends')).toThrow(SwitchCheckStop);
    expect(() => assertSingleSelect('SELECT 1; SELECT 2')).toThrow(SwitchCheckStop);
  });

  it('stops preswitch when any globally applicable rule exists', async () => {
    const calls: string[] = [];
    const query: Query = async (sql) => {
      calls.push(sql); assertSingleSelect(sql);
      if (calls.length === 1) return [{ scenarios: 0, auto_replies: 1, automations: 0, outgoing_webhooks: 0, scoring_rules: 0, entry_routes: 0 }];
      if (calls.length === 2) return [{ total_accounts: 2, active_accounts: 2, matching_accounts: 1, account_id: 'acc-1',
        pool_memberships_active: 1, pool_default_account_count: 0 }];
      return [{ account_id: 'acc-1', forward_raw_url_count: 0 }];
    };
    const result = await run(['preswitch', '--channel-id', '12345'], query);
    expect(result.verdict).toBe('STOP_GLOBAL_RULES');
    expect(calls).toHaveLength(3);
  });

  it('reports review-only counts without gating preswitch', async () => {
    let call = 0;
    const query: Query = async () => {
      call += 1;
      if (call === 1) return [{ scenarios: 0, auto_replies: 0, automations: 0,
        outgoing_webhooks: 2, scoring_rules: 1, entry_routes: 3 }];
      if (call === 2) return [{ total_accounts: 2, active_accounts: 2, matching_accounts: 1, account_id: 'acc-1',
        pool_memberships_active: 0, pool_default_account_count: 0 }];
      return [{ account_id: 'acc-1', forward_raw_url_count: 0 }];
    };
    const result = await run(['preswitch', '--channel-id', '12345'], query);
    expect(result).toMatchObject({
      verdict: 'PASS',
      global_rule_counts: { scenarios: 0, auto_replies: 0, automations: 0 },
      review_counts: { outgoing_webhooks: 2, scoring_rules: 1, entry_routes: 3 },
      review_required: true,
    });
  });

  it('stops preswitch for target pool membership after global rules pass', async () => {
    let call = 0;
    const query: Query = async () => {
      call += 1;
      if (call === 1) return [{ scenarios: 0, auto_replies: 0, automations: 0,
        outgoing_webhooks: 0, scoring_rules: 0, entry_routes: 0 }];
      if (call === 2) return [{ total_accounts: 2, active_accounts: 2, matching_accounts: 1, account_id: 'acc-1',
        pool_memberships_active: 1, pool_default_account_count: 0 }];
      return [{ account_id: 'acc-1', forward_raw_url_count: 0 }];
    };
    const result = await run(['preswitch', '--channel-id', '12345'], query);
    expect(result).toMatchObject({ verdict: 'STOP_POOL_MEMBERSHIP', pool_memberships_active: 1,
      pool_default_account_count: 0, review_required: false });
  });

  it('passes postswitch only with active account, forwarding, and no Harness sends/enrollments', async () => {
    const query: Query = async (sql, params) => {
      assertSingleSelect(sql);
      expect(params[0]).toBe('12345');
      return [{ matching_accounts: 1, active_accounts: 1, forward_raw_url_count: 1,
        pool_memberships_active: 0, pool_default_account_count: 0,
        friends_total: 4, friends_since: 2, incoming_since: 3, outgoing_since: 0, enrollments_since: 0 }];
    };
    const result = await run(['postswitch', '--channel-id', '12345', '--since', '2026-10-08T00:00:00Z'], query);
    expect(result.verdict).toBe('PASS');
    expect(result.since).toBe(normalizeSince('2026-10-08T00:00:00Z'));
  });

  it('fails postswitch if Harness sent anything', async () => {
    const query: Query = async () => [{ matching_accounts: 1, active_accounts: 1, forward_raw_url_count: 1,
      pool_memberships_active: 0, pool_default_account_count: 0,
      friends_total: 1, friends_since: 1, incoming_since: 1, outgoing_since: 1, enrollments_since: 0 }];
    expect((await run(['postswitch', '--channel-id', '9', '--since', '2026-10-08T00:00:00Z'], query)).verdict).toBe('FAIL');
  });

  it('fails postswitch while the account is a pool default', async () => {
    const query: Query = async () => [{ matching_accounts: 1, active_accounts: 1, forward_raw_url_count: 1,
      pool_memberships_active: 0, pool_default_account_count: 1,
      friends_total: 0, friends_since: 0, incoming_since: 0, outgoing_since: 0, enrollments_since: 0 }];
    const result = await run(['postswitch', '--channel-id', '9', '--since', '2026-10-08T00:00:00Z'], query);
    expect(result).toMatchObject({ verdict: 'FAIL', pool_memberships_active: 0, pool_default_account_count: 1 });
  });

  it('fails postswitch while an active pool membership remains', async () => {
    const query: Query = async () => [{ matching_accounts: 1, active_accounts: 1, forward_raw_url_count: 1,
      pool_memberships_active: 1, pool_default_account_count: 0,
      friends_total: 0, friends_since: 0, incoming_since: 0, outgoing_since: 0, enrollments_since: 0 }];
    const result = await run(['postswitch', '--channel-id', '9', '--since', '2026-10-08T00:00:00Z'], query);
    expect(result).toMatchObject({ verdict: 'FAIL', pool_memberships_active: 1, pool_default_account_count: 0 });
  });
});
