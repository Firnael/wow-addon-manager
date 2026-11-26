// Addons on disk, their sources, installs and removals. No UI here: the TUI and the
// plain commands (`wam check`, `wam update`) both sit on top of this module.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdtemp, readdir, readFile, readlink, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { linkDir } from './platform.mjs';
import { extract } from './zip.mjs';
import * as curse from './curse.mjs';
import * as github from './github.mjs';
import * as catalog from './catalog.mjs';
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
  const name = basename(dir);
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
  if (!existsSync(addonsDir)) throw new Error(`dossier AddOns introuvable : ${addonsDir} (le régler avec : wam dir <chemin>)`);
  const ents = (await readdir(addonsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of ents) {
    if (ent.name.startsWith('.')) continue;
    const path = join(addonsDir, ent.name);
    const link = ent.isSymbolicLink();
    if (!link && !ent.isDirectory()) continue;
    const toc = await readToc(path);
    if (!toc) continue;
    if (link) {
      const target = await readlink(path);
      list.push({ name: ent.name, title: toc.title ?? ent.name, notes: toc.notes, version: toc.version, dirs: [ent.name], local: true, target, repo: repoOf(target) });
      continue;
    }
    const tracked = Object.entries(state).find(([, s]) => s.dirs?.includes(ent.name));
    const src = tracked ? tracked[1].source : KNOWN[ent.name] ?? (toc.curse ? { curse: toc.curse } : null);
    const key = src ? keyOf(src) : null;
    if (key && byKey.has(key)) { byKey.get(key).dirs.push(ent.name); continue; }
    const installed = key ? state[key] : null;
    // own: one of our addons running its release; installed.link is where `wam dev` relinks it.
    const a = { name: ent.name, title: toc.title ?? ent.name, notes: toc.notes, version: toc.version, dirs: [ent.name], source: src, key, installed, own: Boolean(installed?.link) };
    if (key) byKey.set(key, a);
    list.push(a);
  }
  return list;
}

// GitHub owner/repo of the git repo a symlinked addon points into, from its origin remote.
function repoOf(target) {
  try { return github.repoFromRemote(execFileSync('git', ['-C', target, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return null; }
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
    const r = await fetch(remote.url, { headers: { 'user-agent': UA, ...remote.headers } });
    if (!r.ok) throw new Error(`téléchargement : HTTP ${r.status}`);
    const out = join(tmp, 'x');
    await extract(Buffer.from(await r.arrayBuffer()), out);
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
    state[key] = { ref: remote.ref, file: remote.name, source: src, dirs, title: title ?? state[key]?.title, link: state[key]?.link, at: new Date().toISOString().slice(0, 10) };
    await saveState(state);
    return dirs;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// One of our symlinked addons -> its latest GitHub release. The symlink is put back if the
// install fails, and its target is kept in the state for `toDev`.
export async function toRelease(addon) {
  if (!addon.local) throw new Error(`${addon.title} n'est pas un lien`);
  if (!addon.repo) throw new Error(`${addon.title} : pas de remote GitHub dans ${addon.target}`);
  const { addonsDir } = config();
  const src = { github: addon.repo };
  const remote = await latest(src);
  const path = join(addonsDir, addon.name);
  await unlink(path);
  let dirs;
  try { dirs = await install(src, remote, { title: addon.title }); }
  catch (e) { if (!existsSync(path)) await linkDir(addon.target, path); throw e; }
  if (!dirs.includes(addon.name)) {
    for (const d of dirs) await rm(join(addonsDir, d), { recursive: true, force: true });
    await linkDir(addon.target, path);
    const state = await loadState(); delete state[keyOf(src)]; await saveState(state);
    throw new Error(`la release ${remote.name} ne contient pas de dossier ${addon.name} (${dirs.join(', ')})`);
  }
  const state = await loadState();
  state[keyOf(src)].link = addon.target;
  await saveState(state);
  return remote;
}

// Back from the release to the symlink into the git repo, to work on the addon.
export async function toDev(addon) {
  const target = addon.installed?.link;
  if (!target) throw new Error(`${addon.title} n'a pas été installé par wam release`);
  if (!(await readToc(target))) throw new Error(`${target} : pas de .toc, lien non recréé`);
  const { addonsDir } = config();
  for (const d of addon.dirs) {
    const p = join(addonsDir, d);
    if (await isLink(p)) throw new Error(`${d} est déjà un lien`);
    await rm(p, { recursive: true, force: true });
  }
  await linkDir(target, join(addonsDir, addon.name));
  const state = await loadState();
  delete state[addon.key];
  await saveState(state);
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

// Installs a CurseForge project and its required dependencies that are missing (the
// dependency lookup needs the API key). Returns the titles installed. onStep(text) narrates.
export async function installCurse(id, title, { onStep = () => {}, seen = new Set(), have } = {}) {
  if (seen.has(id)) return [];
  seen.add(id);
  have ??= new Set((await scan()).map((a) => a.key));
  const remote = await curse.latestFile(id);
  const dirs = await install({ curse: id }, remote, { title });
  const done = [title ?? dirs[0]];
  have.add(`curse:${id}`);
  if (!curse.hasKey()) return done;
  for (const dep of await curse.requiredDeps(id, remote.fileId)) {
    if (have.has(`curse:${dep}`)) continue;
    const m = await curse.mod(dep).catch(() => null);
    onStep(`Dépendance : ${m?.name ?? dep}…`);
    done.push(...await installCurse(dep, m?.name, { onStep, seen, have }));
  }
  return done;
}

// "Add" accepts a CurseForge link or project number, or a GitHub owner/repo (or its URL).
// Returns the titles (CurseForge) or folders (GitHub) installed.
export async function add(text, { onStep = () => {} } = {}) {
  text = String(text ?? '').trim();
  const gh = text.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git|\/.*)?$/);
  const cfSlug = text.match(/curseforge\.com\/wow\/addons\/([\w-]+)/)?.[1];
  const cfId = text.match(/^\d+$/) ? Number(text) : Number(text.match(/curseforge\.com\/projects\/(\d+)/)?.[1]) || null;
  if (cfId || cfSlug) {
    await catalog.load();
    const m = cfId ? await curse.mod(cfId).catch(() => ({ id: cfId })) : catalog.bySlug(cfSlug);
    if (!m) throw new Error(`« ${cfSlug} » absent du catalogue Forever : donner plutôt son numéro de projet (page CurseForge, « Project ID »)`);
    onStep(`Installation de ${m.name ?? m.id}…`);
    return installCurse(m.id, m.name, { onStep });
  }
  if (gh && !text.includes(' ')) {
    const src = { github: gh[1], asset: 'forever.*\\.zip$' };
    onStep(`Recherche d'une release Forever sur ${gh[1]}…`);
    const remote = await latest(src);
    const dirs = await install(src, remote);
    return dirs.map((d) => `${d} (${remote.name})`);
  }
  throw new Error('format non reconnu : lien CurseForge, numéro de projet ou owner/repo GitHub');
}

// An addon picked by folder name or title, case-insensitive.
export const find = (addons, name) => addons.find((a) => [a.name, a.title].some((s) => s?.toLowerCase() === String(name).toLowerCase()));

export function pageOf(a) {
  // The project's own page when the catalog knows it (load it first), else the id redirect.
  if (a?.source?.curse) return catalog.byId(a.source.curse)?.url ?? `https://www.curseforge.com/projects/${a.source.curse}`;
  if (a?.source?.github) return `https://github.com/${a.source.github}`;
  if (a?.repo) return `https://github.com/${a.repo}`;
  return null;
}

// Runs fn over items with at most n at once, in order of completion.
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}
