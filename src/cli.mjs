// wam: WoW Forever addon manager.
// Every TUI action has a command (see USAGE below); with no argument, the TUI.

import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openUrl, useSystemCA } from './platform.mjs';
import { config, saveConfig, loadState, saveState } from './config.mjs';
import * as core from './core.mjs';
import * as catalog from './catalog.mjs';
import * as curse from './curse.mjs';

const USAGE = `wam                        interface (sans argument)
wam check [addon…]         versions et mises à jour disponibles
wam update [addon…]        met à jour ce qui est en retard (tout, ou les addons nommés)
wam add <source…>          installe : lien CurseForge, numéro de projet ou owner/repo GitHub
wam remove [-y] <addon…>   supprime (demande confirmation sans -y)
wam search <mots…>         cherche dans le catalogue Forever (clé requise)
wam catalog                reconstruit le catalogue
wam open <addon>           ouvre la page de l'addon
wam release <addon…>       un de nos addons : lien -> dernière release GitHub
wam dev <addon…>           retour au lien vers le repo
wam key                    enregistre la clé API CurseForge (saisie masquée)
wam dir [chemin]           affiche ou règle le dossier AddOns
wam version                version de wam

<addon> : nom du dossier ou titre, sans tenir compte de la casse.`;

// One-time import of the state left by the old AddOns/update-addons.mjs script.
async function migrate() {
  const old = join(config().addonsDir, '.update-addons.json');
  if (!existsSync(old)) return;
  const state = await loadState();
  for (const [key, ref] of Object.entries(JSON.parse(await readFile(old, 'utf8')))) {
    if (state[key]) continue;
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const source = kind === 'curse' ? { curse: Number(id) } : { github: id, ...(id === 'Questie/QuestieDB' ? { asset: '-Forever\\.zip$' } : {}) };
    state[key] = { ref, source };
  }
  await saveState(state);
  await rm(old);
  await rm(join(config().addonsDir, 'update-addons.mjs'), { force: true });
}

// Addons named on the command line (all when none); an unknown name is an error.
async function pick(names) {
  const addons = await core.scan();
  if (!names.length) return addons;
  return names.map((n) => core.find(addons, n) ?? { title: n, missing: true });
}

async function plain(update, names) {
  const addons = await pick(names);
  let behind = 0, failed = 0;
  for (const a of addons) {
    if (a.missing) { failed++; console.log(`✗  ${a.title} : introuvable dans AddOns`); continue; }
    if (a.local) { console.log(`   ${a.title} ${a.version ?? ''} (perso, lien${a.repo ? '' : ', sans remote GitHub'})`); continue; }
    if (!a.source) { console.log(`?  ${a.title} ${a.version ?? ''} : source inconnue`); continue; }
    try {
      const remote = await core.latest(a.source);
      if (core.upToDate(a, remote)) { console.log(`=  ${a.title} ${a.version ?? ''}${a.own ? ' (perso, release)' : ''}`); continue; }
      if (!update) { behind++; console.log(`↑  ${a.title} ${a.version ?? '?'} -> ${remote.name}`); continue; }
      const dirs = await core.install(a.source, remote, { title: a.title });
      behind++; // counted once installed, so a failed update is not reported as done
      console.log(`✓  ${a.title} ${a.version ?? '?'} -> ${remote.name} (${dirs.join(', ')})`);
    } catch (e) {
      failed++;
      console.log(`✗  ${a.title} : ${e.message}`);
    }
  }
  console.log(update ? `${behind} mis à jour, ${failed} en erreur.${behind ? ' /reload en jeu pour les charger.' : ''}`
    : `${behind} mise(s) à jour disponible(s), ${failed} en erreur.`);
  if (failed) process.exitCode = 1;
}

// Own addons named by folder or title, either mode.
async function switchMode(names, dev) {
  if (!names.length) throw new Error(`wam ${dev ? 'dev' : 'release'} <addon…>`);
  const addons = await core.scan();
  let ok = 0;
  for (const n of names) {
    const a = core.find(addons, n);
    try {
      if (!a) throw new Error('introuvable dans AddOns');
      if (dev) { await core.toDev(a); console.log(`✓  ${a.title} : lien vers ${a.installed.link}`); }
      else { const r = await core.toRelease(a); console.log(`✓  ${a.title} : release ${r.version} (${r.name})`); }
      ok++;
    } catch (e) { process.exitCode = 1; console.log(`✗  ${a?.title ?? n} : ${e.message}`); }
  }
  if (ok) console.log('/reload en jeu pour les charger.');
}

async function add(sources) {
  if (!sources.length) throw new Error('wam add <lien CurseForge | numéro de projet | owner/repo GitHub>…');
  let ok = 0;
  for (const src of sources) {
    try { console.log(`✓  ${(await core.add(src, { onStep: (m) => console.log(`   ${m}`) })).join(', ')}`); ok++; }
    catch (e) { process.exitCode = 1; console.log(`✗  ${src} : ${e.message}`); }
  }
  if (ok) console.log('/reload en jeu pour les charger.');
}

function confirm(question) {
  return new Promise((resolve) => {
    process.stdout.write(`${question} [o/N] `);
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => { process.stdin.pause(); resolve(/^[oy]/i.test(d.trim())); });
  });
}

async function remove(args) {
  const yes = args.includes('-y');
  const names = args.filter((a) => a !== '-y');
  if (!names.length) throw new Error('wam remove [-y] <addon…>');
  for (const a of await pick(names)) {
    try {
      if (a.missing) throw new Error('introuvable dans AddOns');
      if (a.local) throw new Error('addon perso (lien) : à retirer à la main');
      if (!yes) {
        if (!process.stdin.isTTY) throw new Error('pas de terminal pour confirmer : ajouter -y');
        if (!(await confirm(`Supprimer ${a.title} (${a.dirs.join(', ')}) ?`))) { console.log(`   ${a.title} gardé`); continue; }
      }
      await core.remove(a);
      console.log(`✓  ${a.title} supprimé (${a.dirs.join(', ')})`);
    } catch (e) { process.exitCode = 1; console.log(`✗  ${a.title} : ${e.message}`); }
  }
}

// Builds or refreshes the catalog when needed, progress on stderr so stdout stays clean.
async function ensureCatalog(force) {
  if (!curse.hasKey()) throw new Error('la recherche demande une clé CurseForge : wam key');
  await catalog.load();
  if (!force && catalog.fresh()) return;
  const first = !catalog.size();
  const tty = process.stderr.isTTY;
  if (!tty) process.stderr.write(`${first ? 'Construction' : 'Mise à jour'} du catalogue…\n`);
  await catalog.build((n) => { if (tty) process.stderr.write(`\r${first ? 'Construction' : 'Mise à jour'} du catalogue : ${n} addons…`); });
  process.stderr.write(`${tty ? '\r' : ''}Catalogue : ${catalog.size()} addons Forever.${tty ? ' '.repeat(20) : ''}\n`);
}

async function search(words) {
  if (!words.length) throw new Error('wam search <mots…>');
  await ensureCatalog(false);
  const res = catalog.search(words.join(' '));
  if (!res.length) return console.log('Aucun résultat.');
  const have = new Set((await core.scan()).map((a) => a.key));
  const n = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}k` : String(x ?? ''));
  for (const r of res.slice(0, 25)) {
    console.log(`${String(r.id).padStart(8)}  ${r.name.slice(0, 40).padEnd(40)} ${n(r.downloads).padStart(6)}  ${(r.author ?? '').slice(0, 18).padEnd(18)} ${have.has(`curse:${r.id}`) ? 'installé' : ''}`);
  }
  console.log(`${res.length > 25 ? `${res.length} résultats, 25 premiers. ` : ''}Installer : wam add <numéro>`);
}

async function openPage(names) {
  if (names.length !== 1) throw new Error('wam open <addon>');
  const [a] = await pick(names);
  await catalog.load();
  const url = a.missing ? null : core.pageOf(a);
  if (!url) throw new Error(a.missing ? `${a.title} : introuvable dans AddOns` : `${a.title} : pas de page connue`);
  openUrl(url);
  console.log(url);
}

// Reads the key without echoing it, so it never lands in the terminal scrollback.
function askKey() {
  return new Promise((resolve) => {
    process.stdout.write('Clé API CurseForge (console.curseforge.com > API keys) : ');
    let key = '';
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    // A paste arrives as one chunk, maybe wrapped in bracketed-paste markers: go char by char.
    process.stdin.on('data', (chunk) => {
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\x03') process.exit(130);
        if (ch === '\r' || ch === '\n') {
          if (!key) continue; // a newline copied before the key
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
          return resolve(key);
        }
        if (ch === '\x7f' || ch === '\b') key = key.slice(0, -1);
        else if (ch > ' ' && ch <= '~') key += ch;
      }
    });
  });
}

// `echo "$CF_KEY" | wam key` also works.
async function pipedKey() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s.trim();
}

useSystemCA();
const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'version' || cmd === '-v' || cmd === '--version') {
    console.log(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
    process.exit(0);
  }
  if (cmd === 'dir') {
    if (args.length) {
      const dir = resolve(args.join(' '));
      if (!existsSync(dir)) throw new Error(`${dir} : dossier introuvable`);
      saveConfig({ addonsDir: dir });
    }
    console.log(config().addonsDir);
    process.exit(0);
  }
  await migrate();
  if (!cmd) await (await import('./tui.mjs')).run();
  else if (cmd === 'check') await plain(false, args);
  else if (cmd === 'update') await plain(true, args);
  else if (cmd === 'add') await add(args);
  else if (cmd === 'remove' || cmd === 'rm') await remove(args);
  else if (cmd === 'search') await search(args);
  else if (cmd === 'catalog') await ensureCatalog(true);
  else if (cmd === 'open') await openPage(args);
  else if (cmd === 'release' || cmd === 'dev') await switchMode(args, cmd === 'dev');
  else if (cmd === 'key') {
    const key = process.stdin.isTTY ? await askKey() : await pipedKey();
    if (!key) throw new Error('clé vide, rien enregistré');
    // Tested before it is saved, so a bad paste never replaces a working key.
    process.env.CURSEFORGE_API_KEY = key;
    // Tested on a project sheet (/mods/search answers 403 to console keys, see src/catalog.mjs).
    const { mod } = await import('./curse.mjs');
    const m = await mod(298842).catch((e) => {
      throw new Error(`clé refusée (${e.message}), rien enregistré. ${key.length} caractères lus, commence par « ${key.slice(0, 7)} ».`);
    });
    saveConfig({ apiKey: key });
    console.log(`Clé enregistrée et testée (fiche « ${m.name} » lue).`);
  } else {
    console.log(USAGE);
    if (!['help', '-h', '--help'].includes(cmd)) process.exitCode = 1;
  }
} catch (e) {
  console.error(`wam : ${e.message}`);
  process.exit(1);
}
