// Addons published as GitHub release assets (e.g. QuestieDB's "-Forever.zip").

import { UA } from './config.mjs';

export async function latestAsset(repo, pattern) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub ${repo} : HTTP ${r.status}`);
  const rel = await r.json();
  const a = rel.assets.find((x) => pattern.test(x.name));
  if (!a) throw new Error(`${repo} ${rel.tag_name} : aucun fichier ${pattern}`);
  return { ref: `github:${a.id}`, name: a.name, url: a.browser_download_url, version: rel.tag_name, date: rel.published_at, deps: [] };
}
