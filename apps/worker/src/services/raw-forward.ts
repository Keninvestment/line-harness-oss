/** Forward an authenticated LINE webhook to an account's existing SaaS endpoint. */

const RETRY_DELAYS_MS = [500, 2000] as const;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface ForwardRawBodyOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * POST the untouched body and original signature. Failures are deliberately
 * contained so forwarding and LINE Harness processing remain independent.
 */
export async function forwardRawBody(
  url: string,
  rawBody: string,
  signature: string,
  options: ForwardRawBodyOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalAttempts = RETRY_DELAYS_MS.length + 1;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let succeeded = false;

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        body: rawBody,
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': signature,
        },
        signal: controller.signal,
      });
      succeeded = response.ok;
    } catch {
      // Network and timeout errors follow the same bounded retry policy.
    } finally {
      clearTimeout(timeout);
    }

    if (succeeded) return;
    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  // Do not log the destination, signature, body, or underlying fetch error:
  // any of those can contain customer or credential-adjacent data.
  console.error(`[webhook] raw forwarding failed after ${totalAttempts} attempts`);
}
