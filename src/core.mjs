// Addons on disk, their sources, installs and removals. No UI here: the TUI and the
// plain commands (`wam check`, `wam update`) both sit on top of this module.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdtemp, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as curse from './curse.mjs';
import * as github from './github.mjs';
import { config, loadState, saveState } from './config.mjs';

export { UA } from './config.mjs';
import { UA } from './config.mjs';

// Addons whose .toc carries no X-Curse-Project-ID. A source picked in the TUI
// (install from search or from a GitHub repo) is remembered in the state instead.
const KNOWN = {
  '!BugGrabber': { curse: 13344 },
  DialogueUI: { curse: 989270 },
  QuestieDB: { github: 'Questie/QuestieDB', asset: '-Forever\\.zip$' },
};

export const keyOf = (src) => (src.curse ? `curse:${src.curse}` : `github:${src.github}`);
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function readToc(dir) {
  let files;
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.toc')); } catch { return null; }
  const name = dir.split('/').pop();
  const toc = files.find((f) => f === `${name}.toc`) ?? files.find((f) => /_(Forever|Camelot|Vanilla)\.toc$/i.test(f)) ?? files[0];
  if (!toc) return null;
  const text = await readFile(join(dir, toc), 'utf8');
  const tag = (k) => text.match(new RegExp(`^## ${k}:\\s*(.+?)\\s*$`, 'mi'))?.[1];
  const title = tag('Title')?.replace(/\|c[0-9a-f]{8}|\|r/gi, '').trim();
  return { version: tag('Version'), title, notes: tag('Notes'), curse: Number(tag('X-Curse-Project-ID')) || null };
}

// One entry per addon: folders that come from the same source are grouped
// (e.g. an addon and its _Options folder), so updating or removing acts on all.
export async function scan() {
  const { addonsDir } = config();
  const state = await loadState();
  const byKey = new Map();
  const list = [];
  const ents = (await readdir(addonsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue;
    const path = join(addonsDir, ent.name);
    const link = ent.isSymbolicLink();
    if (!link && !ent.isDirectory()) continue;
    const toc = await readToc(path);
    if (!toc) continue;
    if (link) {
      list.push({ name: ent.name, title: toc.title ?? ent.name, version: toc.version, dirs: [ent.name], local: true, target: await readlink(path) });
      continue;
    }
    const tracked = Object.entries(state).find(([, s]) => s.dirs?.includes(ent.name));
    const src = tracked ? tracked[1].source : KNOWN[ent.name] ?? (toc.curse ? { curse: toc.curse } : null);
    const key = src ? keyOf(src) : null;
    if (key && byKey.has(key)) { byKey.get(key).dirs.push(ent.name); continue; }
    const a = { name: ent.name, title: toc.title ?? ent.name, notes: toc.notes, version: toc.version, dirs: [ent.name], source: src, key, installed: key ? state[key] : null };
    if (key) byKey.set(key, a);
    list.push(a);
  }
  return list;
}

// Latest remote file for an addon's source: { ref, name, url, version, date, deps }.
export function latest(src) {
  return src.curse ? curse.latestFile(src.curse) : github.latestAsset(src.github, new RegExp(src.asset ?? 'forever.*\\.zip$', 'i'));
}

export function upToDate(addon, remote) {
  if (addon.installed?.ref) return addon.installed.ref === remote.ref;
  const v = norm(addon.version).replace(/^v/, '');
  return Boolean(v) && norm(remote.name).includes(v);
}

async function isLink(path) {
  try { return (await lstat(path)).isSymbolicLink(); } catch { return false; }
}

// Downloads the zip and swaps each folder it holds into AddOns. Refuses a zip
// without addon folders or one that would overwrite a symlinked (own) addon.
export async function install(src, remote, { title } = {}) {
  const { addonsDir } = config();
  const tmp = await mkdtemp(join(tmpdir(), 'wam-'));
  try {
    const r = await fetch(remote.url, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(`téléchargement : HTTP ${r.status}`);
    const zip = join(tmp, 'addon.zip');
    await writeFile(zip, Buffer.from(await r.arrayBuffer()));
    const out = join(tmp, 'x');
    execFileSync('unzip', ['-q', zip, '-d', out]);
    const dirs = (await readdir(out, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('__') && !d.name.startsWith('.')).map((d) => d.name);
    if (!dirs.length) throw new Error('le zip ne contient aucun dossier');
    for (const d of dirs) {
      if (!(await readdir(join(out, d))).some((f) => f.endsWith('.toc'))) throw new Error(`${d} : pas de .toc dans le zip`);
      if (await isLink(join(addonsDir, d))) throw new Error(`${d} est un addon perso (lien), refusé`);
    }
    for (const d of dirs) {
      const dest = join(addonsDir, d), old = join(tmp, `old-${d}`);
      if (existsSync(dest)) await rename(dest, old);
      try { await cp(join(out, d), dest, { recursive: true }); }
      catch (e) { await rm(dest, { recursive: true, force: true }); if (existsSync(old)) await rename(old, dest); throw e; }
    }
    const state = await loadState();
    const key = keyOf(src);
    state[key] = { ref: remote.ref, file: remote.name, source: src, dirs, title: title ?? state[key]?.title, at: new Date().toISOString().slice(0, 10) };
    await saveState(state);
    return dirs;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Removes an addon's folders. Never a symlink: own addons are removed by hand.
export async function remove(addon) {
  if (addon.local) throw new Error('addon perso (lien) : à retirer à la main');
  const { addonsDir } = config();
  for (const d of addon.dirs) {
    const p = join(addonsDir, d);
    if (await isLink(p)) throw new Error(`${d} est un lien, refusé`);
    await rm(p, { recursive: true, force: true });
  }
  if (addon.key) {
    const state = await loadState();
    delete state[addon.key];
    await saveState(state);
  }
}

// Runs fn over items with at most n at once, in order of completion.
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}
