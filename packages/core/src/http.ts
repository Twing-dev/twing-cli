/**
 * Tiny fetch wrapper adding the §17.10 bearer token when present, reused by
 * every TS caller of `twing serve` (`align.ts`, `design.ts`, `init.ts`'s
 * seed call, the daemon's sync loop) instead of each hand-rolling headers.
 */

export function authFetch(url: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...init, headers });
}
