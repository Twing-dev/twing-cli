/**
 * Client-side redaction, applied to every captured turn before anything is
 * written to disk. This runs on conversation text only -- tool inputs and
 * results are already dropped whole by `@twing/core`'s transcript filter --
 * but conversation text is exactly where a pasted credential ends up, and
 * transcripts in this repo have really contained PAT values and
 * `bedrock.env` contents.
 *
 * Four layers, in the order they run. Prior art (entire.io) ships nine, so
 * this is deliberately named as a phase-1 minimum rather than a finished
 * job; it is the one part of capture where under-building has consequences
 * that survive the mistake.
 *
 *  1. Provider token prefixes -- the highest-precision layer: a literal
 *     `ghp_`/`sk-ant-`/`AKIA...` prefix is a credential with near-zero
 *     false-positive risk, so it matches before anything heuristic.
 *  2. Credentialed URIs -- `scheme://user:password@host`, which covers most
 *     DB connection strings on its own.
 *  3. Key-value secrets -- `password=`/`api_key: `/`AWS_SECRET_ACCESS_KEY=`,
 *     the `.env`-file and DSN shape URIs miss.
 *  4. Entropy scoring on long alphanumeric runs -- the catch-all for
 *     everything with no recognizable prefix (twing's own PATs are bare
 *     64-char hex from `crypto.randomBytes`, and match nothing above).
 *
 * Layer 4 is the only heuristic one, so it carries an explicit safe list:
 * git SHAs, UUIDs and hex digests read as high-entropy but are neither
 * secret nor reconstructible-from, and redacting them would quietly gut the
 * usefulness of the captured prose. See `looksLikeSecret`.
 *
 * Measured over a real 90MB session transcript, what survives that safe
 * list is 49 masked spans, nearly all of them genuine PATs, plus two
 * hyphenated mixed-case filenames (`twing-hook.bak-preOutOfScopeFix-...`)
 * and this project's own 64-hex projectIds. That residue is accepted on
 * purpose and in that direction: a false positive costs one unreadable
 * identifier in captured prose, a false negative writes a working
 * credential to disk.
 */

/** What a redacted span is replaced with. Keeps the shape of the sentence
 * (and signals that redaction happened) rather than deleting the span. */
const MASK = "[redacted]";

/** Layer 1: literal prefixes that only ever introduce a credential. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI and the many APIs that copied its shape
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / user / server / refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[A-Za-z0-9_-]{35}\b/g, // Google API key
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm automation token
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Layer 2: `scheme://user:password@host`. Only the credential pair is
 * masked, not the host -- which repo/database a session talked to is
 * exactly the kind of context capture exists to keep. */
const CREDENTIALED_URI = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

/** Layer 3: `key=value` / `key: value` where the key names a secret. The
 * value runs to whitespace, a quote, or a comma -- never across a newline,
 * so a prose sentence ending in "password:" can't swallow the paragraph
 * after it. */
const KEYED_SECRET = /\b((?:[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)))(\s*[:=]\s*)(["']?)([^\s"',;]{6,})\3/gi;

/** Layer 4 candidates: long unbroken runs of base64/hex/token characters.
 * `/` has to be in the class (base64 uses it) which means a filesystem path
 * matches as one long run too -- `maskRun` is what tells the two apart.
 *
 * `=` is trailing-only, never a joining character: allowing it mid-run made
 * `TWING_VERTEX_EXTRACT_MODEL=gemini-2` a single 35-character mixed-class
 * "token" and masked the whole assignment, environment-variable name and
 * all. In base64 `=` is padding, so the end is the only place it belongs. */
const LONG_RUN = /[A-Za-z0-9+/_-]{24,}={0,2}/g;

/** A run containing `/` is ambiguous: `/Users/dev/Projects/twing-monitor/
 * src/components/RepoListView` reads as high-entropy and mixed-class just
 * like a base64 blob does, and masking it would gut the capture -- file
 * paths are explicitly part of what capture keeps (repo attribution, and
 * later the fold's routing).
 *
 * Slash *density* separates them. Base64 draws `/` as one symbol in 64, so
 * a blob carries one or two across 40 characters; a filesystem path is
 * mostly slashes. So: judge a run whole only when it is long and has at
 * most a couple of segments, and otherwise score each segment on its own --
 * which still catches a secret sitting in a path-shaped position.
 *
 * The residual gap is a raw base64 secret carrying enough `/` to look like
 * a path. The realistic case is an AWS secret access key, already covered
 * more precisely by layer 3 since it virtually always appears as
 * `AWS_SECRET_ACCESS_KEY=...`. */
function maskRun(run: string): string {
  if (!run.includes("/")) return looksLikeSecret(run) ? MASK : run;

  const segments = run.split("/");
  if (segments.length <= 3 && run.length >= 40 && looksLikeSecret(run)) return MASK;
  return segments.map((s) => (looksLikeSecret(s) ? MASK : s)).join("/");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ONLY = /^[0-9a-f]+$/i;
const DECIMAL_ONLY = /^[0-9]+$/;

/** Shannon entropy in bits per character. A random 64-char hex string sits
 * near 4.0 (its alphabet's ceiling); English prose and identifiers sit well
 * under 3.5, which is where the threshold below is set. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Layer 4's decision. Two independent shapes qualify:
 *
 *  - Mixed-case alphanumerics (three character classes present) with high
 *    entropy -- base64 keys, bearer tokens, session ids.
 *  - A long hex run (>= 40 chars) that isn't a git SHA or a standard digest
 *    length. twing's own PATs are 64 hex chars, so this case has to exist;
 *    it's kept narrow by excluding exactly the lengths real digests use.
 *
 * Both exclude UUIDs outright. A UUID is high-entropy by construction and
 * appears constantly in this project's own prose (design ids, session ids,
 * thread ids) -- masking them would make the capture unreadable while
 * protecting nothing, since a UUID is an identifier, not a credential.
 */
export function looksLikeSecret(candidate: string): boolean {
  if (candidate.length < 24) return false;
  if (UUID.test(candidate)) return false;
  if (DECIMAL_ONLY.test(candidate)) return false;

  if (HEX_ONLY.test(candidate)) {
    // 7/8 (short SHA), 32 (md5), 40 (sha1/git), 56, 64 (sha256), 96, 128
    // (sha512) -- a digest, not a secret. 64 is the collision that matters:
    // it's both a sha256 and twing's own PAT length, and a captured
    // conversation quotes sha256 digests far more often than it quotes a
    // live PAT. Masked anyway, deliberately: a false positive costs one
    // unreadable digest, a false negative writes a working credential to
    // disk.
    const digestLengths = new Set([7, 8, 32, 40, 56, 96, 128]);
    if (digestLengths.has(candidate.length)) return false;
    return candidate.length >= 40;
  }

  const hasLower = /[a-z]/.test(candidate);
  const hasUpper = /[A-Z]/.test(candidate);
  const hasDigit = /[0-9]/.test(candidate);

  // Mixed case *and* digits. Requiring digits specifically -- rather than
  // "any three of four character classes" -- is what keeps human-written
  // identifiers out: `-Users-mb-Projects-twing-cli` is 28 chars of mixed
  // case with plenty of entropy, and it is a directory name, not a secret.
  // Randomly generated tokens essentially always carry digits.
  if (hasLower && hasUpper && hasDigit) return shannonEntropy(candidate) >= 3.5;

  // Lowercase-and-digits only, with no `-`/`_` separators to suggest a
  // human wrote it: base32-ish API keys land here. Held to a stricter
  // length and entropy bar, since concatenated English words reach ~3.5-4.0
  // on their own while a random alphanumeric run of this length sits above
  // 4.2.
  if (hasLower && hasDigit && !hasUpper && !/[-_=+/]/.test(candidate)) {
    return candidate.length >= 32 && shannonEntropy(candidate) >= 4.2;
  }

  return false;
}

/**
 * Runs every layer over one string. Idempotent in the sense that matters:
 * `[redacted]` contains no run long enough to re-trigger anything, so
 * re-redacting already-redacted text is a no-op.
 */
export function redact(text: string): string {
  let out = text;

  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, MASK);
  out = out.replace(CREDENTIALED_URI, (_m, scheme, user, _pass) => `${scheme}${user}:${MASK}@`);
  out = out.replace(KEYED_SECRET, (_m, key, sep, quote) => `${key}${sep}${quote}${MASK}${quote}`);
  out = out.replace(LONG_RUN, maskRun);

  return out;
}
