// CurseForge. Two APIs:
// - the website's (www.curseforge.com/api/v1/mods/<id>/files, .../download): no key, enough to
//   find and download a project's latest file. Its search and project pages answer 403.
// - the official one (api.curseforge.com/v1, header x-api-key): project details, file
//   dependencies and the featured lists the catalog is built from (search itself is refused). Free key from console.curseforge.com, stored by `wam key`.

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

export const shape = (m) => ({
  id: m.id, slug: m.slug, name: m.name, summary: m.summary, downloads: m.downloadCount,
  author: m.authors?.[0]?.name, updated: m.dateReleased ?? m.dateModified, url: m.links?.websiteUrl,
  forever: (m.latestFilesIndexes ?? []).some((f) => isForever(f.gameVersion)),
  logo: m.logo?.thumbnailUrl ?? m.logo?.url ?? null,
});

// /v1/mods/search answers 403 for console keys: see catalog.mjs. Featured skips excludedIds.
const FOREVER_TYPE = 88568; // gameVersionTypeId of WoW Forever (1.60.x)
export async function featured(excludedModIds) {
  const key = config().apiKey;
  if (!key) throw new Error('pas de clé CurseForge : lancer `wam key`');
  const r = await fetch(`${API}/mods/featured`, {
    method: 'POST',
    headers: { 'user-agent': UA, accept: 'application/json', 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ gameId: WOW, gameVersionTypeId: FOREVER_TYPE, excludedModIds }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur /mods/featured`);
  return (await r.json()).data;
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
