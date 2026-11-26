// Config and state live in ~/.config/wam/:
//   config.json  { addonsDir, apiKey }   (mode 600: holds the CurseForge API key)
//   state.json   { "<source key>": { ref, file, source, dirs, title, at } }

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultAddonsDir } from './platform.mjs';

export const UA = 'wow-addon-manager/1.0';
export const DIR = process.env.WAM_HOME || join(homedir(), '.config', 'wam');
const CONFIG = join(DIR, 'config.json');
const STATE = join(DIR, 'state.json');

let cache;
export function config() {
  if (!cache) {
    const file = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
    cache = { addonsDir: defaultAddonsDir(), ...file };
  }
  return process.env.CURSEFORGE_API_KEY ? { ...cache, apiKey: process.env.CURSEFORGE_API_KEY } : cache;
}

export function saveConfig(patch) {
  mkdirSync(DIR, { recursive: true });
  const file = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
  writeFileSync(CONFIG, JSON.stringify({ ...file, ...patch }, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(CONFIG, 0o600); } catch { /* no POSIX modes (Windows) */ }
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
