// CurseForge. Two APIs:
// - the website's (www.curseforge.com/api/v1/mods/<id>/files, .../download): no key, enough to
//   find and download a project's latest file. Its search and project pages answer 403.
// - the official one (api.curseforge.com/v1, header x-api-key): search, project details and
//   file dependencies. Free key from console.curseforge.com, stored by `wam key`.

import { config } from './config.mjs';
import { UA } from './config.mjs';

const WEB = 'https://www.curseforge.com/api/v1/mods';
const API = 'https://api.curseforge.com/v1';
const WOW = 1;
export const isForever = (v) => /^1\.60\./.test(v);

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url.replace(/\?.*/, '')}`);
  return r.json();
}

export const hasKey = () => Boolean(config().apiKey);

function api(path) {
  const key = config().apiKey;
  if (!key) throw new Error('pas de clé CurseForge : lancer `wam key`');
  return getJson(`${API}${path}`, { 'x-api-key': key });
}

// Newest stable file that lists a 1.60.x client (Forever). Multi-flavour zips count.
export async function latestFile(id) {
  const list = await getJson(`${WEB}/${id}/files?pageIndex=0&pageSize=50&sort=dateCreated&sortDescending=true`);
  const f = (list.data ?? []).find((x) => x.releaseType === 1 && x.gameVersions?.some(isForever))
    ?? (list.data ?? []).find((x) => x.gameVersions?.some(isForever)); // beta/alpha only
  if (!f) throw new Error('aucun fichier Forever parmi les 50 derniers');
  return {
    ref: `curse:${f.id}`, fileId: f.id, name: f.fileName, url: `${WEB}/${id}/files/${f.id}/download`,
    version: f.displayName, date: f.dateCreated, beta: f.releaseType !== 1,
  };
}

const shape = (m) => ({
  id: m.id, slug: m.slug, name: m.name, summary: m.summary, downloads: m.downloadCount,
  author: m.authors?.[0]?.name, updated: m.dateReleased ?? m.dateModified, url: m.links?.websiteUrl,
  forever: (m.latestFilesIndexes ?? []).some((f) => isForever(f.gameVersion)),
});

// Sorted by popularity. `forever` tells whether a recent file targets 1.60.x.
export async function search(text) {
  const q = new URLSearchParams({ gameId: WOW, searchFilter: text, sortField: 2, sortOrder: 'desc', pageSize: 50 });
  return (await api(`/mods/search?${q}`)).data.map(shape);
}

export async function bySlug(slug) {
  const q = new URLSearchParams({ gameId: WOW, slug });
  const m = (await api(`/mods/search?${q}`)).data[0];
  if (!m) throw new Error(`aucun projet « ${slug} »`);
  return shape(m);
}

export async function mod(id) {
  return shape((await api(`/mods/${id}`)).data);
}

// Project ids a file needs (relationType 3 = required). Empty without a key.
export async function requiredDeps(id, fileId) {
  if (!hasKey()) return [];
  const f = (await api(`/mods/${id}/files/${fileId}`)).data;
  return (f.dependencies ?? []).filter((d) => d.relationType === 3).map((d) => d.modId);
}
