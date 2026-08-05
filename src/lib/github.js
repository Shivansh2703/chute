/**
 * GitHub Contents API helpers — the write target for captures.
 */

import { envValue } from './env.js';

export class GithubError extends Error {
  constructor(status, body) {
    let short = body;
    try {
      const parsed = JSON.parse(body);
      short = parsed.message || body;
    } catch {
      // body wasn't JSON, use as-is
    }
    short = (short || '').toString().slice(0, 200);
    super(short);
    this.status = status;
    this.short = short;
  }
}

// ---- base64 helpers (UTF-8 safe) ----

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function b64decodeUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// The token and repo are pasted in by hand (`wrangler secret put`, wrangler.toml),
// so both go through `envValue` — a wrapping quote or trailing newline here
// would 401 or 404 every write with a message that points nowhere near the
// actual mistake.
export function ghHeaders(env, extra) {
  return {
    Authorization: `Bearer ${envValue(env, 'GITHUB_TOKEN')}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'chute',
    Accept: 'application/vnd.github+json',
    ...extra,
  };
}

function repo(env) {
  return envValue(env, 'GITHUB_REPO');
}

function branch(env) {
  return envValue(env, 'GITHUB_BRANCH') || 'main';
}

export async function githubGetFile(path, env) {
  const url = `https://api.github.com/repos/${repo(env)}/contents/${path}?ref=${branch(env)}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (res.status === 404) return { exists: false };
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GithubError(res.status, body);
  }
  const json = await res.json();
  return { exists: true, sha: json.sha, content: b64decodeUtf8(json.content) };
}

export async function githubPutFile(path, content, sha, message, env) {
  const url = `https://api.github.com/repos/${repo(env)}/contents/${path}`;
  const body = { message, content: b64encodeUtf8(content), branch: branch(env) };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: ghHeaders(env, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new GithubError(res.status, errBody);
  }
  return res.json();
}
