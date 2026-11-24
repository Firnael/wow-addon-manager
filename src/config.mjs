// Config and state live in ~/.config/wam/:
//   config.json  { addonsDir, apiKey }   (mode 600: holds the CurseForge API key)
//   state.json   { "<source key>": { ref, file, source, dirs, title, at } }

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const UA = 'wow-addon-manager/1.0';
const DIR = process.env.WAM_HOME || join(homedir(), '.config', 'wam');
const CONFIG = join(DIR, 'config.json');
const STATE = join(DIR, 'state.json');
const DEFAULT_ADDONS = '/Applications/World of Warcraft/_forever_/Interface/AddOns';

let cache;
export function config() {
  if (!cache) {
    const file = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
    cache = { addonsDir: DEFAULT_ADDONS, ...file };
    if (process.env.CURSEFORGE_API_KEY) cache.apiKey = process.env.CURSEFORGE_API_KEY;
  }
  return cache;
}

export function saveConfig(patch) {
  mkdirSync(DIR, { recursive: true });
  const file = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
  writeFileSync(CONFIG, JSON.stringify({ ...file, ...patch }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG, 0o600);
  cache = undefined;
}

export async function loadState() {
  if (!existsSync(STATE)) return {};
  const state = JSON.parse(await readFile(STATE, 'utf8'));
  return state;
}

export async function saveState(state) {
  mkdirSync(DIR, { recursive: true });
  await writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
}
