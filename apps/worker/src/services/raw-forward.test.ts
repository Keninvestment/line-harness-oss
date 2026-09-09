import { describe, expect, test, vi } from 'vitest';
import { forwardRawBody } from './raw-forward.js';

const instantSleep = () => vi.fn().mockResolvedValue(undefined);

describe('forwardRawBody', () => {
  test('forwards the exact body and original signature', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const rawBody = '  {"events":[]}  ';
    const signature = 'sensitive-signature';

    await forwardRawBody('https://saas.example.com/hook/', rawBody, signature, {
      fetchImpl,
      sleep: instantSleep(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://saas.example.com/hook/', {
      method: 'POST',
      body: rawBody,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Line-Signature': signature,
      },
      signal: expect.anything(),
    });
  });

  test.each([302, 307])(
    'fails closed on HTTP %i without replaying the signed body to the redirect sink',
    async (status) => {
      const sink = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
      const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        // Model native fetch's redirect behavior: redirect:error rejects at
        // the origin; without it, the request would be replayed to the sink.
        if (init?.redirect === 'error') {
          throw new TypeError(`redirect response ${status}`);
        }
        return sink('https://redirect-sink.example.com/hook', init);
      });
      const sleep = instantSleep();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await forwardRawBody(
        'https://saas.example.com/hook',
        '{"secret":"customer-body"}',
        'customer-signature',
        { fetchImpl: fetchImpl as typeof fetch, sleep },
      );

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(fetchImpl.mock.calls.every((call) => call[1]?.redirect === 'error')).toBe(true);
      expect(sink).not.toHaveBeenCalled();
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    },
  );

  test('retries non-2xx and network failures with bounded backoff', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const sleep = instantSleep();

    await forwardRawBody('https://saas.example.com/hook', '{}', 'sig', { fetchImpl, sleep });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 2000);
  });

  test('aborts each bounded attempt and never throws', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      forwardRawBody('https://saas.example.com/hook', '{}', 'sig', {
        fetchImpl: fetchImpl as typeof fetch,
        sleep: instantSleep(),
        timeoutMs: 1,
      }),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1]?.signal?.aborted).toBe(true);
    }
    errorSpy.mockRestore();
  });

  test('exhaustion log does not expose target, body, signature, or fetch error', async () => {
    const url = 'https://secret.example.com/customer/123';
    const body = '{"secret":"customer-body"}';
    const signature = 'customer-signature';
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network error for secret.example.com'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await forwardRawBody(url, body, signature, { fetchImpl, sleep: instantSleep() });

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(url);
    expect(logged).not.toContain(body);
    expect(logged).not.toContain(signature);
    expect(logged).not.toContain('secret.example.com');
    errorSpy.mockRestore();
  });
});
