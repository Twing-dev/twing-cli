/**
 * A tiny wrapper around fetch used across this service. No retry behavior
 * yet -- a failed request just throws.
 */
export async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`request to ${url} failed: ${res.status}`);
  }
  return res.json();
}
