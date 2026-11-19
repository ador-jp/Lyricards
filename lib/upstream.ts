const UPSTREAM_TIMEOUT_MS = 5_000;

export function fetchUpstream(url: string): Promise<Response> {
  return fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
}
