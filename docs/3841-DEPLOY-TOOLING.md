# #3841 deploy and switch tooling

These scripts are intentionally fail-closed. Run networked commands only on KEN's terminal after the matching approval has been issued. They print sanitized JSON and never print tokens or the forwarding URL path/query.

## Worker artifact and deploy

```sh
pnpm exec tsx scripts/worker-3841-code-only-deploy.ts build
pnpm exec tsx scripts/worker-3841-code-only-deploy.ts preflight
pnpm exec tsx scripts/worker-3841-code-only-deploy.ts apply --approval-id 3841-D1-YYYYMMDD --expires 2026-10-08T12:00:00+09:00
pnpm exec tsx scripts/worker-3841-code-only-deploy.ts rollback --approval-id 3841-RB-YYYYMMDD --expires 2026-10-08T12:00:00+09:00
```

`build` requires the read-only artifact worktree to be clean at exact head `bd2ca007e1222f8a3ec9b98a90a1a518e27a6140`. It builds in scratch copies and writes two byte-identical artifacts under `/Users/kensmba/.line-harness-3841-BUILD-YYYYMMDD-final{1,2}`. `apply` permits one content PUT, never retries or rolls back automatically, and writes `/Users/kensmba/.line-harness-3841-D1-YYYYMMDD/sanitized-summary.json` (directory 0700, file 0600).

## D1 switch checks (read-only)

```sh
pnpm exec tsx scripts/d1-3841-switch-check.ts preswitch --channel-id 1234567890
pnpm exec tsx scripts/d1-3841-switch-check.ts postswitch --channel-id 1234567890 --since 2026-10-08T10:00:00+09:00
```

Only the three message-sending global rule counts in `scenarios` (`friend_add`), `auto_replies`, and `automations` decide `STOP_GLOBAL_RULES`. `outgoing_webhooks`, `scoring_rules`, and `entry_routes` are reported separately under `review_counts`; they do not gate the verdict, and any nonzero value sets `review_required=true`.

When the channel already exists, preswitch also reports active `pool_accounts` memberships and `traffic_pools.active_account_id` references. Either count produces `STOP_POOL_MEMBERSHIP`, but only after the three global-rule counts pass. Postswitch requires both pool counts to be zero in addition to the existing account, forwarding, outgoing-message, and scenario-enrollment checks.

The postswitch message counts use `messages_log.line_account_id`, falling back to the friend's current account for legacy/unstamped rows. This is the best available aggregate, not immutable historical attribution. Also, the hard-coded `体験を完了する` webhook branch sends without writing an outgoing `messages_log` row, so `messages_outgoing_since=0` cannot detect that exceptional path.

## Remove a registered account from traffic pools

Run this immediately after `POST /api/line-accounts` and before relying on friend-add links or the switch checks:

```sh
pnpm exec tsx scripts/remove-from-pools-3841.ts ACCOUNT_ID
```

The script uses the same `LINE_HARNESS_API_KEY` loader as the forwarding setter. It lists at most 100 pools, lists every pool's memberships, deletes every active or inactive membership for the target using the `pool_accounts` row id required by the API, and lists each pool again to require `remaining=0`. It performs no retries and makes at most 301 API calls (`1 + 2 * pools + removals`). Successful output contains only `account_id`, `removed`, and `remaining`.

If any pool has the target in `activeAccountId` (the API form of `traffic_pools.active_account_id`), it stops before every DELETE with `stop_reason=pool_default_account`. Removing only its membership would be unsafe because LIFF can fall back to that default account.

## Configure raw forwarding

```sh
# Hidden terminal input; finish with Ctrl-D
pnpm exec tsx scripts/set-forward-raw-url-3841.ts ACCOUNT_ID

# The URL file must be a regular, non-symlink file with mode 0600
pnpm exec tsx scripts/set-forward-raw-url-3841.ts ACCOUNT_ID --file /absolute/path/to/url.txt

pnpm exec tsx scripts/set-forward-raw-url-3841.ts ACCOUNT_ID --clear
```

The setter reads only `LINE_HARNESS_API_KEY` from `/Users/kensmba/.line-harness/.env.local`, performs exactly one PUT or DELETE followed by one GET, and reports only account id, set state, scheme, host, and a SHA-256 of path plus query.
