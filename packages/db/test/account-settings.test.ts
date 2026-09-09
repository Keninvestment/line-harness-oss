import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getForwardRawUrl,
  getLinkBaseUrl,
  setForwardRawUrl,
  setLinkBaseUrl,
} from '../src/account-settings.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const benignMigrationError = /duplicate column name|already exists/i;

function execSafe(db: Database.Database, sql: string): void {
  for (const statement of sql.split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    try {
      db.exec(statement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!benignMigrationError.test(message)) throw err;
    }
  }
}

function setupDb(): { sqlite: Database.Database; d1: D1Database } {
  const sqlite = new Database(':memory:');
  execSafe(sqlite, readFileSync(join(packageRoot, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(packageRoot, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    execSafe(sqlite, readFileSync(join(packageRoot, 'migrations', file), 'utf8'));
  }
  sqlite.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_secret, channel_access_token, created_at, updated_at)
     VALUES (?, ?, 'Test', 'secret', 'token', '2026-01-01', '2026-01-01')`,
  ).run('acc-1', 'channel-1');

  const d1 = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          const statement = sqlite.prepare(query);
          return {
            async run() {
              statement.run(...params);
              return { results: [], success: true, meta: {} };
            },
            async first<T>() {
              return (statement.get(...params) as T) ?? null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { sqlite, d1 };
}

describe('forward_raw_url', () => {
  test('returns null when unset and round-trips a valid URL', async () => {
    const { d1 } = setupDb();
    expect(await getForwardRawUrl(d1, 'acc-1')).toBeNull();
    await setForwardRawUrl(d1, 'acc-1', 'https://saas.example.com/webhook');
    expect(await getForwardRawUrl(d1, 'acc-1')).toBe('https://saas.example.com/webhook');
  });

  test('preserves the opaque trailing slash and trims only surrounding whitespace', async () => {
    const { d1 } = setupDb();
    await setForwardRawUrl(d1, 'acc-1', '  https://saas.example.com/webhook/  ');
    expect(await getForwardRawUrl(d1, 'acc-1')).toBe('https://saas.example.com/webhook/');
  });

  test.each([
    'http://saas.example.com/webhook',
    'httpsx://saas.example.com/webhook',
    'https://',
    'not a url',
    'https://user@saas.example.com/webhook',
    'https://user:secret@saas.example.com/webhook',
  ])('rejects unsafe or malformed target %s', async (value) => {
    const { d1 } = setupDb();
    await expect(setForwardRawUrl(d1, 'acc-1', value)).rejects.toThrow(/HTTPS URL/);
    expect(await getForwardRawUrl(d1, 'acc-1')).toBeNull();
  });

  test('empty string clears the setting', async () => {
    const { d1 } = setupDb();
    await setForwardRawUrl(d1, 'acc-1', 'https://saas.example.com/webhook/');
    await setForwardRawUrl(d1, 'acc-1', '  ');
    expect(await getForwardRawUrl(d1, 'acc-1')).toBeNull();
  });

  test('is scoped by account and independent from link_base_url normalization', async () => {
    const { sqlite, d1 } = setupDb();
    sqlite.prepare(
      `INSERT INTO line_accounts
         (id, channel_id, name, channel_secret, channel_access_token, created_at, updated_at)
       VALUES (?, ?, 'Test 2', 'secret', 'token', '2026-01-01', '2026-01-01')`,
    ).run('acc-2', 'channel-2');

    await setForwardRawUrl(d1, 'acc-1', 'https://saas.example.com/webhook/');
    await setLinkBaseUrl(d1, 'acc-1', 'https://links.example.com/');
    expect(await getForwardRawUrl(d1, 'acc-1')).toBe('https://saas.example.com/webhook/');
    expect(await getForwardRawUrl(d1, 'acc-2')).toBeNull();
    expect(await getLinkBaseUrl(d1, 'acc-1')).toBe('https://links.example.com');
  });
});
