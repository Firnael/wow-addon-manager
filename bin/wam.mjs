#!/usr/bin/env -S node --use-system-ca
// wam: WoW Forever addon manager.
//   wam           TUI (installed addons, updates, search, add, remove)
//   wam check     list addons and available updates
//   wam update    update every third-party addon that is behind
//   wam key       store the CurseForge API key (asked without echo)
//   wam release <addon…>   one of our symlinked addons -> its latest GitHub release
//   wam dev <addon…>       back to the symlink into its git repo

import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config, saveConfig, loadState, saveState } from '../src/config.mjs';
import * as core from '../src/core.mjs';

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

async function plain(update) {
  const addons = await core.scan();
  let behind = 0, failed = 0;
  for (const a of addons) {
    if (a.local) { console.log(`   ${a.title} ${a.version ?? ''} (perso, lien${a.repo ? '' : ', sans remote GitHub'})`); continue; }
    if (!a.source) { console.log(`?  ${a.title} ${a.version ?? ''} : source inconnue`); continue; }
    try {
      const remote = await core.latest(a.source);
      if (core.upToDate(a, remote)) { console.log(`=  ${a.title} ${a.version ?? ''}${a.own ? ' (perso, release)' : ''}`); continue; }
      behind++;
      if (!update) { console.log(`↑  ${a.title} ${a.version ?? '?'} -> ${remote.name}`); continue; }
      const dirs = await core.install(a.source, remote, { title: a.title });
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
    const a = addons.find((x) => [x.name, x.title].some((s) => s?.toLowerCase() === n.toLowerCase()));
    try {
      if (!a) throw new Error('introuvable dans AddOns');
      if (dev) { await core.toDev(a); console.log(`✓  ${a.title} : lien vers ${a.installed.link}`); }
      else { const r = await core.toRelease(a); console.log(`✓  ${a.title} : release ${r.version} (${r.name})`); }
      ok++;
    } catch (e) { process.exitCode = 1; console.log(`✗  ${a?.title ?? n} : ${e.message}`); }
  }
  if (ok) console.log('/reload en jeu pour les charger.');
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
        if (ch === '\x7f') key = key.slice(0, -1);
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

const cmd = process.argv[2];
try {
  await migrate();
  if (!cmd) await (await import('../src/tui.mjs')).run();
  else if (cmd === 'check') await plain(false);
  else if (cmd === 'update') await plain(true);
  else if (cmd === 'release' || cmd === 'dev') await switchMode(process.argv.slice(3), cmd === 'dev');
  else if (cmd === 'key') {
    const key = process.stdin.isTTY ? await askKey() : await pipedKey();
    if (!key) throw new Error('clé vide, rien enregistré');
    // Tested before it is saved, so a bad paste never replaces a working key.
    process.env.CURSEFORGE_API_KEY = key;
    // Tested on a project sheet (/mods/search answers 403 to console keys, see src/catalog.mjs).
    const { mod } = await import('../src/curse.mjs');
    const m = await mod(298842).catch((e) => {
      throw new Error(`clé refusée (${e.message}), rien enregistré. ${key.length} caractères lus, commence par « ${key.slice(0, 7)} ».`);
    });
    saveConfig({ apiKey: key });
    console.log(`Clé enregistrée et testée (fiche « ${m.name} » lue).`);
  } else {
    console.log('wam [check | update | key | release <addon…> | dev <addon…>]  (sans argument : interface)');
  }
} catch (e) {
  console.error(`wam : ${e.message}`);
  process.exit(1);
}
