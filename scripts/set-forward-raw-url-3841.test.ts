import { describe, expect, it, vi } from 'vitest';
import { parseHarnessApiKey, run, validateDestination, ForwardUrlStop } from './set-forward-raw-url-3841.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('#3841 forward_raw_url setter', () => {
  it('parses only the single Harness key without exposing it', () => {
    expect(parseHarnessApiKey('OTHER=x\nLINE_HARNESS_API_KEY="secret"\n')).toBe('secret');
    expect(() => parseHarnessApiKey('LINE_HARNESS_API_KEY=a\nLINE_HARNESS_API_KEY=b')).toThrow(ForwardUrlStop);
  });

  it('requires HTTPS without credentials or fragments', () => {
    expect(validateDestination(' https://example.com/a?q=1 ').value).toBe('https://example.com/a?q=1');
    expect(() => validateDestination('http://example.com/a')).toThrow(ForwardUrlStop);
    expect(() => validateDestination('https://example.com/a#secret')).toThrow(ForwardUrlStop);
  });

  it('does one PUT and one GET, and prints no URL path or query', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json({ success: true, data: 'https://receiver.example/private/path?token=hidden' }));
    const result = await run(['acc-1'], { apiKey: 'top-secret', request,
      readStdin: () => 'https://receiver.example/private/path?token=hidden', readFile: () => '' });
    expect(request.mock.calls.map((call) => call[1].method)).toEqual(['PUT', 'GET']);
    expect(result).toMatchObject({ account_id: 'acc-1', set: true, scheme: 'https', host: 'receiver.example' });
    const output = JSON.stringify(result);
    expect(output).not.toContain('private'); expect(output).not.toContain('hidden'); expect(output).not.toContain('top-secret');
  });

  it('does one DELETE and one GET for clear', async () => {
    const request = vi.fn().mockResolvedValueOnce(json({ success: true })).mockResolvedValueOnce(json({ success: true, data: null }));
    const result = await run(['acc-1', '--clear'], { apiKey: 'secret', request, readStdin: () => '', readFile: () => '' });
    expect(request.mock.calls.map((call) => call[1].method)).toEqual(['DELETE', 'GET']);
    expect(result).toEqual({ account_id: 'acc-1', set: false, scheme: null, host: null, path_sha256: null });
  });

  it('stops on readback mismatch without retry', async () => {
    const request = vi.fn().mockResolvedValueOnce(json({ success: true })).mockResolvedValueOnce(json({ success: true, data: null }));
    await expect(run(['acc-1'], { apiKey: 'secret', request, readStdin: () => 'https://example.com/a', readFile: () => '' }))
      .rejects.toMatchObject({ code: 'readback_mismatch' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
