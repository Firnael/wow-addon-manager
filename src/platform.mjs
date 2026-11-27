// What differs between macOS, Windows and Linux: system certificates, opening a page,
// linking a folder, where the game lives.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

export const WIN = process.platform === 'win32';
export const MAC = process.platform === 'darwin';

// Trust the OS certificate store as well as Node's own (what `node --use-system-ca` does):
// behind a corporate proxy (Zscaler) its root certificate is only there.
export function useSystemCA() {
  if (!tls.setDefaultCACertificates || !tls.getCACertificates) return;
  try {
    tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')])]);
  } catch { /* keep Node's bundled list */ }
}

export function openUrl(url) {
  if (!url) return;
  // rundll32 hands the URL to the default browser without going through cmd's parsing (& etc.).
  if (WIN) execFile('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true }).on('error', () => {});
  else execFile(MAC ? 'open' : 'xdg-open', [url]).on('error', () => {});
}

// A folder link. On Windows a junction: unlike a symlink it needs neither admin rights nor
// developer mode, and Node reads it back as a symlink (lstat, readlink).
export const linkDir = (target, path) => symlink(target, path, WIN ? 'junction' : 'dir');

// The AddOns folder of a default install, the first one found (else the most likely one).
export function defaultAddonsDir() {
  const sub = join('World of Warcraft', '_forever_', 'Interface', 'AddOns');
  const roots = WIN ? windowsRoots() : MAC ? ['/Applications'] : [join(homedir(), 'Games')];
  const dirs = roots.map((r) => join(r, sub));
  return dirs.find((d) => existsSync(d)) ?? dirs[0];
}

// Battle.net lets the game go on any drive: Program Files first, then the root and the usual
// game folders of every drive letter that exists (C: to Z:).
function windowsRoots() {
  const roots = [process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramFiles ?? 'C:\\Program Files'];
  for (let c = 67; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    if (!existsSync(drive)) continue;
    for (const sub of ['', 'Program Files (x86)', 'Program Files', 'Games', 'Jeux', 'Battle.net']) roots.push(join(drive, sub));
  }
  return [...new Set(roots)];
}
