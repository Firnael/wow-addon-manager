// Local catalog of Forever addons, searched offline.
//
// /v1/mods/search answers 403 for a console API key (checked 2026-11-24, from Zscaler and from
// the VPS), while /v1/mods/featured works. Featured returns ~20 addons (featured, popular,
// recently updated) and skips the ids in `excludedModIds`, so calling it again with every id
// seen so far walks the whole Forever list, most popular first. ~20 new addons per call.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIR } from './config.mjs';
import { featured, shape } from './curse.mjs';

const FILE = join(DIR, 'catalog.json');
const MAX_AGE = 7 * 864e5;
const MAX_CALLS = 3000;

let cat = null; // { builtAt, complete, mods: [] }
let building = null;

export async function load() {
  if (!cat && existsSync(FILE)) cat = JSON.parse(await readFile(FILE, 'utf8'));
  return cat;
}

export const fresh = () => Boolean(cat?.complete && Date.now() - Date.parse(cat.builtAt) < MAX_AGE);
export const size = () => cat?.mods.length ?? 0;
export const isBuilding = () => Boolean(building);

// Builds (or rebuilds) the catalog; onProgress(count) after each call. Searches made while it
// runs see the addons found so far.
export function build(onProgress = () => {}) {
  if (building) return building;
  building = (async () => {
    // An unfinished build (wam closed midway) resumes from what it had found.
    const resume = cat && !cat.complete;
    const found = new Map(resume ? cat.mods.map((m) => [m.id, m]) : []);
    const next = { builtAt: resume ? cat.builtAt : new Date().toISOString(), complete: false, mods: [...found.values()] };
    for (let i = 0; i < MAX_CALLS; i++) {
      if (i && i % 20 === 0) await writeFile(FILE, JSON.stringify(cat?.complete ? cat : { ...next, mods: [...found.values()] }));
      // A network hiccup (sleep, Wi-Fi change) retries; a lasting failure keeps what was saved.
      let d;
      for (let t = 1; !d; t++) {
        try { d = await featured([...found.keys()]); }
        catch (e) { if (t >= 4) throw e; await new Promise((r) => setTimeout(r, 2000 * t)); }
      }
      let added = 0;
      for (const m of [...d.featured, ...d.popular, ...d.recentlyUpdated]) {
        if (found.has(m.id)) continue;
        found.set(m.id, shape(m));
        added++;
      }
      if (!added) { next.complete = true; break; }
      next.mods = [...found.values()];
      if (!cat?.complete) cat = next; // first build: searchable as it grows
      onProgress(found.size);
    }
    next.mods = [...found.values()];
    cat = next;
    await writeFile(FILE, JSON.stringify(cat));
    return cat;
  })().finally(() => { building = null; });
  return building;
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Every word must appear in the name, summary or author. Name hits first, then downloads.
export function search(text) {
  const words = fold(text).split(/\s+/).filter(Boolean);
  if (!cat || !words.length) return [];
  const hits = [];
  for (const m of cat.mods) {
    const name = fold(m.name), all = `${name} ${fold(m.summary)} ${fold(m.author)} ${fold(m.slug)}`;
    if (!words.every((w) => all.includes(w))) continue;
    const score = words.filter((w) => name.includes(w)).length;
    hits.push({ m, score });
  }
  return hits.sort((a, b) => b.score - a.score || b.m.downloads - a.m.downloads).slice(0, 200).map((h) => h.m);
}

export const byId = (id) => cat?.mods.find((m) => m.id === id) ?? null;
export const bySlug = (slug) => cat?.mods.find((m) => m.slug === slug) ?? null;
export const mods = () => cat?.mods ?? [];
