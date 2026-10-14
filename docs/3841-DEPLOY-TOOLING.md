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

## Probe the UTAGE webhook response

```sh
pnpm exec tsx scripts/utage-probe-3841.ts --channel-id 1234567890 --url-file /absolute/path/to/url.txt --approval-id 3841-PR-YYYYMMDD
pnpm exec tsx scripts/utage-probe-3841.ts --channel-id 1234567890 --url-file /absolute/path/to/url.txt --approval-id 3841-PR-YYYYMMDD --signature bad
pnpm exec tsx scripts/utage-probe-3841.ts --channel-id 1234567890 --url-file /absolute/path/to/url.txt --approval-id 3841-PR-YYYYMMDD --no-user-agent
```

Run this networked probe only on KEN's terminal after approval. Each invocation performs one D1 SELECT, one LINE bot-info GET, and exactly one POST with a 10-second timeout, no retry, and no redirect following. The default and `--no-user-agent` modes POST to the validated UTAGE URL. The latter omits the `User-Agent` header entirely (with no `user-agent` key in any casing).

### Mode B: via Harness

In a separate terminal, start this companion read-only live log command before running the probe:

```sh
(set -a; . ~/.line-harness/.env.local; set +a; cd ~/.line-harness-wt/3841-deploy-tooling && ./node_modules/.bin/wrangler tail line-harness --format json) | grep -E 'raw forwarding|"outcome"'
```

It shows only our fixed `raw forwarding` log lines and outcome fields. Then run:

```sh
pnpm exec tsx scripts/utage-probe-3841.ts --channel-id 1234567890 --url-file /absolute/path/to/url.txt --approval-id 3841-PR-YYYYMMDD --via-harness
```

This mode sends exactly one correctly signed POST to `https://line-harness.family8office.workers.dev/webhook`, with only `Content-Type` and `X-Line-Signature` explicitly set, and does not contact the URL from the URL file. A Harness response status of 200 is expected. `--via-harness` cannot be combined with `--signature bad` or `--no-user-agent`.

In every mode, the URL file is still required and must be a regular, non-symlink file with mode 0600 whose URL passes the UTAGE host validation. Output is sanitized JSON containing `target` (`utage` or `harness`), `user_agent_sent`, the destination validation result, response metadata, the validated UTAGE host, and a SHA-256 of its path plus query. It never prints credentials, the LINE user ID, URL path/query, response body, or redirect location.

## Inspect the failed forwarding window (read-only)

```sh
pnpm exec tsx scripts/cf-logs-3841-forward-window.ts --from 2026-10-12T06:01:28Z --to 2026-10-12T06:09:30Z
```

The window must be positive and no longer than two hours. The script first reads Worker observability settings and stops successfully with `logs_unavailable=true` when logging is disabled. Otherwise it makes one read-only Workers Observability telemetry query. It performs no retries, allows at most five API calls, applies a 60-second deadline and 2 MiB response limit to every call, and prints only observability booleans/numbers plus aggregate `/webhook`, fixed forwarding-failure, exception/outcome, and per-minute counts. It never prints event bodies, headers, full URLs, user identifiers, or raw log lines. When `head_sampling_rate` is less than `1`, the aggregates cover only the sampled observations and are not a complete invocation count.
