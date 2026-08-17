/**
 * Tiny fetch wrapper adding the §17.10 bearer token when present, reused by
 * every TS caller of `twing serve` (`align.ts`, `design.ts`, `init.ts`'s
 * seed call, the daemon's sync loop) instead of each hand-rolling headers.
 *
 * `developerId` (§17 Phase 4) sets the `X-Twing-Developer-Id` header a
 * `--no-auth` coordinator requires in place of a bearer token -- pass it
 * whenever the cached `ServerAuth` for this server has `noAuth: true`.
 * Harmless to pass alongside a real token too (a `full auth` server just
 * ignores it), so callers don't need to branch on the server's mode.
 */

export function authFetch(url: string, init: RequestInit = {}, token?: string, developerId?: string): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (developerId) {
    headers.set("x-twing-developer-id", developerId);
  }
  return fetch(url, { ...init, headers });
}
