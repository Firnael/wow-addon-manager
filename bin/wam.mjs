#!/usr/bin/env -S node --use-system-ca
// wam: WoW Forever addon manager.
//   wam           TUI (installed addons, updates, search, add, remove)
//   wam check     list addons and available updates
//   wam update    update every third-party addon that is behind
//   wam key       store the CurseForge API key (asked without echo)

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
    if (a.local) { console.log(`   ${a.title} ${a.version ?? ''} (perso, lien)`); continue; }
    if (!a.source) { console.log(`?  ${a.title} ${a.version ?? ''} : source inconnue`); continue; }
    try {
      const remote = await core.latest(a.source);
      if (core.upToDate(a, remote)) { console.log(`=  ${a.title} ${a.version ?? ''}`); continue; }
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

// Reads the key without echoing it, so it never lands in the terminal scrollback.
function askKey() {
  return new Promise((resolve) => {
    process.stdout.write('Clé API CurseForge (console.curseforge.com > API keys) : ');
    let key = '';
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (ch) => {
      if (ch === '\x03') process.exit(130);
      if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(key.trim()); }
      else if (ch === '\x7f') key = key.slice(0, -1);
      else key += ch;
    });
  });
}

const cmd = process.argv[2];
try {
  await migrate();
  if (!cmd) await (await import('../src/tui.mjs')).run();
  else if (cmd === 'check') await plain(false);
  else if (cmd === 'update') await plain(true);
  else if (cmd === 'key') {
    if (!process.stdin.isTTY) throw new Error('à lancer dans un terminal');
    const key = await askKey();
    if (!key) throw new Error('clé vide, rien enregistré');
    saveConfig({ apiKey: key });
    const { search } = await import('../src/curse.mjs');
    const n = (await search('leatrix')).length;
    console.log(`Clé enregistrée et testée (${n} résultats pour « leatrix »).`);
  } else {
    console.log('wam [check | update | key]  (sans argument : interface)');
  }
} catch (e) {
  console.error(`wam : ${e.message}`);
  process.exit(1);
}
