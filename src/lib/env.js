/**
 * Env/secret access helpers.
 */

// Secrets arrive via `wrangler secret put` pastes — stray whitespace and
// wrapping quotes (both common paste artifacts) must never reach an API call
// or a token comparison.
export function envValue(env, name) {
  return String(env[name] || '').trim().replace(/^["']+|["']+$/g, '').trim();
}

// Constant-time-ish string compare. Both sides are hashed to a fixed width
// first so the loop below never leaks the secret's length through timing,
// then compared byte-for-byte with no early exit.
export async function secretEquals(a, b) {
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(String(a))),
    crypto.subtle.digest('SHA-256', encoder.encode(String(b))),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
