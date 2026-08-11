/**
 * Shared-password auth (§17.10 / design doc): one secret per server, not a
 * user/account system. The "token" a client stores is deliberately just
 * `sha256(password)` -- stateless to verify (no session table), survives a
 * server restart without forcing everyone to re-run `twing init`, and
 * doesn't hand back the plaintext password if a stored token ever leaks.
 */

import * as crypto from "node:crypto";

export function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}
