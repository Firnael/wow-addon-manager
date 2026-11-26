// Addons published as GitHub release assets (e.g. QuestieDB's "-Forever.zip", and our own
// addons once switched from their symlink to their release).

import { execFileSync } from 'node:child_process';
import { UA } from './config.mjs';

// A token reaches private repos (our addons before they go public) and lifts the rate limit.
// GITHUB_TOKEN / GH_TOKEN first, else the gh CLI's own login; none is fine for public repos.
let token;
function auth() {
  if (token === undefined) {
    token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (!token) try { token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { token = ''; }
  }
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function latestAsset(repo, pattern) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json', ...auth() } });
  if (r.status === 404) throw new Error(`GitHub ${repo} : aucune release (ou repo privé sans accès)`);
  if (!r.ok) throw new Error(`GitHub ${repo} : HTTP ${r.status}`);
  const rel = await r.json();
  const a = rel.assets.find((x) => pattern.test(x.name));
  if (!a) throw new Error(`${repo} ${rel.tag_name} : aucun fichier ${pattern}`);
  // With a token, the asset API (works for private repos; it redirects to the file, and fetch
  // drops the authorization header on that cross-origin redirect). Without, the public link.
  const remote = { ref: `github:${a.id}`, name: a.name, url: a.browser_download_url, version: rel.tag_name, date: rel.published_at, deps: [] };
  const h = auth();
  if (h.authorization) Object.assign(remote, { url: a.url, headers: { ...h, accept: 'application/octet-stream' } });
  return remote;
}

// owner/repo from a git remote URL (ssh or https), or null when it is not on GitHub.
export function repoFromRemote(url) {
  return String(url ?? '').trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? null;
}
