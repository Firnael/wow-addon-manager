// Full-screen terminal UI, no dependencies: raw stdin, ANSI escapes, alternate screen.
// Two views: installed addons (check, update, remove, add) and CurseForge search.

import { execFile } from 'node:child_process';
import * as core from './core.mjs';
import { config } from './config.mjs';
import { homedir } from 'node:os';
import * as curse from './curse.mjs';
import * as catalog from './catalog.mjs';

const out = process.stdout;
const ESC = '\x1b[';
const c = {
  dim: (s) => `${ESC}2m${s}${ESC}22m`, bold: (s) => `${ESC}1m${s}${ESC}22m`,
  green: (s) => `${ESC}32m${s}${ESC}39m`, yellow: (s) => `${ESC}33m${s}${ESC}39m`, red: (s) => `${ESC}31m${s}${ESC}39m`,
  cyan: (s) => `${ESC}36m${s}${ESC}39m`, inv: (s) => `${ESC}7m${s}${ESC}27m`,
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---- look ---------------------------------------------------------------------------------
// The "retro" gradient (indigo -> pink -> gold), in 24-bit colour when the terminal says so,
// else the nearest of the 256-colour cube.
const TRUE = /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
const RETRO = ['#3f51b1', '#5a55ae', '#7b5fac', '#8f6aae', '#a86aa4', '#cc6b8e', '#f18271', '#f3a469', '#f7c978']
  .map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
const cube = ([r, g, b]) => 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
const fg = (rgb) => (TRUE ? `${ESC}38;2;${rgb.join(';')}m` : `${ESC}38;5;${cube(rgb)}m`);
const bg = (rgb) => (TRUE ? `${ESC}48;2;${rgb.join(';')}m` : `${ESC}48;5;${cube(rgb)}m`);
const RESET = `${ESC}0m`;
// Colour at t in [0, 1] along the gradient.
function at(t) {
  const x = Math.min(1, Math.max(0, t)) * (RETRO.length - 1), i = Math.min(RETRO.length - 2, Math.floor(x)), f = x - i;
  return RETRO[i].map((v, k) => Math.round(v + (RETRO[i + 1][k] - v) * f));
}
// Text painted along the gradient; phase shifts it (ping-pong, so it never jumps).
function grad(lines, phase = 0) {
  const w = Math.max(...lines.map((l) => [...l].length)) + lines.length * 2;
  return lines.map((l, row) => [...l].map((ch, col) => {
    if (ch === ' ') return ch;
    const t = (col + row * 2) / w + phase;
    return fg(at(1 - Math.abs((t % 2) - 1))) + ch;
  }).join('') + RESET);
}
const accent = (s) => fg(RETRO[7]) + s + RESET;
const soft = (s) => fg(RETRO[3]) + s + RESET;
const SEL = bg([52, 46, 92]);
const vlen = (s) => [...strip(s)].length;

const BIG = [
  '██╗    ██╗ █████╗ ███╗   ███╗',
  '██║    ██║██╔══██╗████╗ ████║',
  '██║ █╗ ██║███████║██╔████╔██║',
  '██║███╗██║██╔══██║██║╚██╔╝██║',
  '╚███╔███╔╝██║  ██║██║ ╚═╝ ██║',
  ' ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝     ╚═╝',
];
const SMALL = ['█ █ █ ▄▀█ █▀▄▀█', '▀▄▀▄▀ █▀█ █ ▀ █'];
const VERSION = '1.2.0';
const fit = (s, w) => { s = String(s ?? ''); return s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w); };
const fmtN = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? '');
const day = (d) => (d ? String(d).slice(0, 10) : '');

const ui = {
  view: 'installed',
  addons: [], status: new Map(), sel: 0, top: 0,
  search: { query: '', input: true, results: [], sel: 0, top: 0, all: false, loading: false, done: false },
  prompt: null, // { label, value, submit(value) } or { label, confirm(yes) }
  msg: '', busy: 0,
  splash: true, phase: 0,
};

function say(m) { ui.msg = m; draw(); }

// ---- data ---------------------------------------------------------------------------------

async function rescan() {
  ui.addons = await core.scan();
  ui.sel = Math.min(ui.sel, Math.max(0, ui.addons.length - 1));
  draw();
}

async function checkOne(a) {
  if (a.local) return ui.status.set(a.name, { s: 'local' });
  if (!a.source) return ui.status.set(a.name, { s: 'unknown' });
  ui.status.set(a.name, { s: 'checking' }); draw();
  try {
    const remote = await core.latest(a.source);
    ui.status.set(a.name, { s: core.upToDate(a, remote) ? 'ok' : 'update', remote });
  } catch (e) { ui.status.set(a.name, { s: 'error', err: e.message }); }
  draw();
}

async function checkAll() {
  say('Vérification des versions…');
  await core.pool(ui.addons, 5, checkOne);
  const n = ui.addons.filter((a) => ui.status.get(a.name)?.s === 'update').length;
  say(n ? `${n} mise${n > 1 ? 's' : ''} à jour disponible${n > 1 ? 's' : ''} : u pour celle choisie, U pour tout.` : 'Tout est à jour.');
}

async function updateOne(a) {
  const st = ui.status.get(a.name);
  if (st?.s !== 'update') return false;
  ui.status.set(a.name, { ...st, s: 'busy' }); draw();
  try {
    await core.install(a.source, st.remote, { title: a.title });
    ui.status.set(a.name, { s: 'ok', remote: st.remote, fresh: true });
    return true;
  } catch (e) { ui.status.set(a.name, { s: 'error', err: e.message }); return false; }
}

async function updateAll() {
  const todo = ui.addons.filter((a) => ui.status.get(a.name)?.s === 'update');
  if (!todo.length) return say('Rien à mettre à jour.');
  say(`Mise à jour de ${todo.length} addon(s)…`);
  let ok = 0;
  for (const a of todo) if (await updateOne(a)) ok++;
  await rescan();
  say(`${ok}/${todo.length} mis à jour. /reload en jeu pour les charger.`);
}

const installCurse = (id, title) => core.installCurse(id, title, { onStep: say, have: new Set(ui.addons.map((a) => a.key)) });

async function add(text) {
  ui.busy++; draw();
  try { say(`Installé : ${(await core.add(text, { onStep: say })).join(', ')}. /reload en jeu.`); }
  catch (e) { say(c.red(`Échec : ${e.message}`)); }
  ui.busy--;
  await rescan();
  ui.addons.forEach((a) => { if (!ui.status.has(a.name)) checkOne(a); });
}

// Search runs on the local catalog (catalog.mjs). It is built on first use, refreshed when a
// week old; results follow the build as it grows.
function ensureCatalog() {
  if (!curse.hasKey() || catalog.isBuilding() || catalog.fresh()) return;
  const first = !catalog.size();
  catalog.build((n) => { ui.catalogMsg = `${first ? 'Construction' : 'Mise à jour'} du catalogue : ${n} addons…`; refreshSearch(); })
    .then((cat) => { ui.catalogMsg = `Catalogue : ${cat.mods.length} addons Forever.`; refreshSearch(); })
    .catch((e) => { ui.catalogMsg = c.red(`Catalogue : ${e.message}`); draw(); });
}

function refreshSearch() {
  const s = ui.search;
  if (s.done) s.results = catalog.search(s.query);
  draw();
}

function runSearch() {
  const s = ui.search;
  if (!s.query.trim()) return;
  if (!curse.hasKey()) return say(c.yellow('La recherche demande une clé CurseForge : quitter et lancer `wam key`.'));
  s.input = false; s.sel = 0; s.top = 0; s.done = true;
  s.results = catalog.search(s.query);
  ensureCatalog();
  draw();
}

const visibleResults = () => ui.search.results;

const pageOf = core.pageOf;
const open = (url) => url && execFile('open', [url]);

// ---- drawing ------------------------------------------------------------------------------

function statusCell(a) {
  const st = ui.status.get(a.name);
  switch (st?.s) {
    case 'local': return c.cyan('perso (lien)');
    case 'unknown': return c.dim('source inconnue');
    case 'checking': return c.dim('…');
    case 'busy': return c.yellow('installation…');
    case 'ok': if (a.own && !st.fresh) return c.green('à jour') + c.cyan(' · perso, release'); return st.fresh ? c.green(`✓ ${st.remote.version ?? 'mis à jour'}`) : c.green('à jour');
    case 'update': return c.yellow(`↑ ${st.remote.version ?? st.remote.name}${st.remote.beta ? ' (bêta)' : ''}`);
    case 'error': return c.red(`✗ ${st.err}`);
    default: return '';
  }
}

function list(rows, sel, top, height, width) {
  const lines = [];
  for (let i = top; i < Math.min(rows.length, top + height); i++) {
    const text = rows[i];
    lines.push(i === sel ? `${SEL}${ESC}1m${accent('▸')}${SEL}${ESC}1m${fit(strip(text).slice(1), width - 1)}${RESET}` : text);
  }
  while (lines.length < height) lines.push('');
  return lines;
}

function scrollTo(obj, len, height) {
  obj.sel = Math.max(0, Math.min(obj.sel, len - 1));
  if (obj.sel < obj.top) obj.top = obj.sel;
  if (obj.sel >= obj.top + height) obj.top = obj.sel - height + 1;
}

function render() {
  const W = out.columns || 100, H = out.rows || 30;
  const L = [];
  const tab = (k, label, on) => (on ? `${bg(RETRO[2])}${ESC}1m ${k} ${label} ${RESET}` : c.dim(` ${k} ${label} `));
  const logo = grad(SMALL, ui.phase);
  const right = (left, r) => left + ' '.repeat(Math.max(1, W - vlen(left) - vlen(r) - 1)) + r;
  // "Forever" then the AddOns folder, ~ for home, cut from the left so its end stays visible.
  const home = homedir(), dir = config().addonsDir.replace(home, '~');
  const room = W - vlen(logo[0]) - 14;
  L.push(right(` ${grad(['Forever'])[0]}  ${fg(RETRO[1])}${dir.length > room ? '…' + dir.slice(-(room - 1)) : dir}${RESET}`, logo[0]));
  L.push(right(` ${tab(1, 'Installés', ui.view === 'installed')}${tab(2, 'Rechercher', ui.view === 'search')}`, logo[1]));
  L.push(soft('─'.repeat(W)));
  const bodyH = H - 9;

  if (ui.view === 'installed') {
    const rows = ui.addons.map((a) => {
      const name = fit(a.title, 32), ver = fit(a.version ?? '', 18);
      return ` ${name} ${c.dim(ver)} ${statusCell(a)}`;
    });
    scrollTo(ui, rows.length, bodyH);
    L.push(...list(rows, ui.sel, ui.top, bodyH, W));
    const a = ui.addons[ui.sel];
    L.push(soft('─'.repeat(W)));
    if (a) {
      const src = a.local ? `lien vers ${a.target}${a.repo ? ` · l : passer à la release de ${a.repo}` : ''}` : a.own ? `release de GitHub ${a.source.github} · l : revenir au lien ${a.installed.link}` : a.source?.curse ? `CurseForge ${a.source.curse}` : a.source?.github ? `GitHub ${a.source.github}` : 'source inconnue : a pour l\'ajouter';
      const cut = (t, w) => (t.length > w ? t.slice(0, Math.max(0, w - 1)) + '…' : t);
      L.push(` ${accent(c.bold(cut(a.title, W - 4)))}  ${c.dim(cut(a.dirs.join(', '), Math.max(0, W - a.title.length - 4)))}`);
      L.push(fit(` ${a.notes ?? ''}`, W));
      L.push(c.dim(fit(` ${src}${a.installed?.at ? ` · installé le ${a.installed.at}` : ''}`, W)));
    } else L.push('', '', '');
  } else {
    const s = ui.search;
    const cursor = s.input ? c.inv(' ') : '';
    L.push(` ${accent('⌕')} ${s.query}${cursor}  ${c.dim(ui.catalogMsg ?? (catalog.size() ? `catalogue : ${catalog.size()} addons Forever` : ''))}`);
    const res = visibleResults();
    const have = new Set(ui.addons.map((a) => a.key));
    const rows = res.map((r) => {
      const tags = have.has(`curse:${r.id}`) ? c.green('installé') : '';
      return ` ${fit(r.name, 40)} ${c.dim(fit(fmtN(r.downloads), 7))} ${c.dim(fit(r.author, 18))} ${tags}`;
    });
    if (!rows.length && s.done) rows.push(c.dim(catalog.isBuilding() ? ' rien pour l\'instant, le catalogue se construit…' : ' aucun résultat'));
    scrollTo(s, res.length || 1, bodyH - 1);
    L.push(...list(rows, s.input ? -1 : s.sel, s.top, bodyH - 1, W));
    const r = res[s.sel];
    L.push(soft('─'.repeat(W)));
    if (r && !s.input) {
      L.push(` ${accent(c.bold(r.name))}  ${c.dim(`${fmtN(r.downloads)} téléchargements · ${r.author ?? ''} · ${day(r.updated)}`)}`);
      L.push(fit(` ${r.summary ?? ''}`, W));
      L.push(c.dim(fit(` ${r.url ?? ''}`, W)));
    } else L.push('', '', '');
  }

  L.push(ui.prompt ? ` ${c.yellow(ui.prompt.label)} ${ui.prompt.value ?? ''}${ui.prompt.confirm ? '' : c.inv(' ')}` : ` ${ui.msg}`);
  const keys = ui.prompt ? (ui.prompt.confirm ? 'o oui · n non' : 'Entrée valider · Échap annuler')
    : ui.view === 'installed'
      ? '↑↓ choisir · u mettre à jour · U tout · r vérifier · a ajouter · d supprimer · l lien/release · o page · Tab recherche · q quitter'
      : ui.search.input ? `Entrée chercher · ↓ résultats · Tab installés · Échap ${ui.search.results.length ? 'quitter la saisie' : 'installés'}`
        : '↑↓ choisir · Entrée installer · o page · / nouvelle recherche · R rafraîchir le catalogue · Tab installés · q quitter';
  L.push(hints(keys, W));
  return L.slice(0, H);
}

// "↑↓ choisir · u mettre à jour" -> key in gold, label dimmed, cut to the width.
function hints(keys, W) {
  let line = ' ', used = 1;
  for (const part of keys.split(' · ')) {
    const sp = part.indexOf(' '), k = part.slice(0, sp), label = part.slice(sp + 1);
    const n = k.length + label.length + 4;
    if (used + n > W) break;
    line += `${accent(k)} ${c.dim(label)}   `; used += n;
  }
  return line;
}

// Splash: the big logo, its gradient sliding, over the first moments while addons load.
function splash() {
  const W = out.columns || 100, H = out.rows || 30;
  const art = grad(BIG, ui.phase);
  const sub = [c.dim('WoW Addons Manager'), '', c.dim(`v${VERSION}`)];
  const block = [...art, '', ...sub];
  const top = Math.max(0, Math.floor((H - block.length) / 2));
  const L = Array(top).fill('');
  for (const l of block) L.push(' '.repeat(Math.max(0, Math.floor((W - vlen(l)) / 2))) + l);
  return L.slice(0, H);
}

let pending = false;
function draw() {
  if (pending) return;
  pending = true;
  setImmediate(() => {
    pending = false;
    out.write(`${ESC}H` + (ui.splash ? splash() : render()).map((l) => l + `${ESC}K`).join('\r\n') + `${ESC}J`);
  });
}

// ---- keys ---------------------------------------------------------------------------------

const KEYS = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[5~': 'pgup', '\x1b[6~': 'pgdown', '\r': 'enter', '\t': 'tab', '\x7f': 'back', '\x1b': 'esc', '\x03': 'ctrl-c' };

function onKey(data) {
  const k = KEYS[data] ?? data;
  if (k === 'ctrl-c') return quit();
  if (ui.splash) return endSplash();

  if (ui.prompt) {
    const p = ui.prompt;
    if (p.confirm) { if (k === 'o' || k === 'y') { ui.prompt = null; p.confirm(true); } else if (k === 'n' || k === 'esc') { ui.prompt = null; say(''); } return draw(); }
    if (k === 'esc') { ui.prompt = null; say(''); }
    else if (k === 'enter') { ui.prompt = null; p.submit(p.value); }
    else if (k === 'back') p.value = p.value.slice(0, -1);
    else if (data >= ' ' && !data.startsWith('\x1b')) p.value += data;
    return draw();
  }

  if (k === 'tab' || (k === '1' && !ui.search.input) || (k === '2' && ui.view === 'installed')) {
    ui.view = k === '1' ? 'installed' : k === '2' ? 'search' : ui.view === 'installed' ? 'search' : 'installed';
    if (ui.view === 'search' && !ui.search.done) ui.search.input = true;
    return draw();
  }

  if (ui.view === 'search') {
    const s = ui.search;
    if (s.input) {
      if (k === 'enter') runSearch();
      else if (k === 'back') s.query = s.query.slice(0, -1);
      // Esc leaves the field (back to the installed tab when there is nothing to browse), and
      // 1 on an empty field switches tab like it does everywhere else.
      else if (k === 'esc' || k === 'down') { if (s.results.length) s.input = false; else if (k === 'esc') ui.view = 'installed'; }
      else if (k === '1' && !s.query) ui.view = 'installed';
      else if (data >= ' ' && !data.startsWith('\x1b')) s.query += data;
      return draw();
    }
    const res = visibleResults();
    const r = res[s.sel];
    if (k === 'q') return quit();
    if (k === 'up' || k === 'k') { if (s.sel === 0) s.input = true; else s.sel--; }
    else if (k === 'down' || k === 'j') s.sel++;
    else if (k === 'pgup') s.sel -= 10;
    else if (k === 'pgdown') s.sel += 10;
    else if (k === '/') { s.input = true; s.query = ''; }
    else if (k === 'R' && !catalog.isBuilding()) { catalog.build((n) => { ui.catalogMsg = `Mise à jour du catalogue : ${n} addons…`; draw(); }).then((cat) => { ui.catalogMsg = `Catalogue : ${cat.mods.length} addons Forever.`; refreshSearch(); }, (e) => { ui.catalogMsg = c.red(`Catalogue : ${e.message}`); draw(); }); }
    else if (k === 'o' && r) open(r.url);
    else if ((k === 'enter' || k === 'i') && r) {
      ui.prompt = { label: `Installer ${r.name}${r.forever ? '' : ' (aucun fichier Forever récent annoncé)'} ?`, confirm: async () => {
        say(`Installation de ${r.name}…`);
        try { say(`Installé : ${(await installCurse(r.id, r.name)).join(', ')}. /reload en jeu.`); }
        catch (e) { say(c.red(`Échec : ${e.message}`)); }
        await rescan();
        ui.addons.forEach((a) => { if (!ui.status.has(a.name)) checkOne(a); });
      } };
    }
    return draw();
  }

  const a = ui.addons[ui.sel];
  if (k === 'q' || k === 'esc') return quit();
  if (k === 'up' || k === 'k') ui.sel--;
  else if (k === 'down' || k === 'j') ui.sel++;
  else if (k === 'pgup') ui.sel -= 10;
  else if (k === 'pgdown') ui.sel += 10;
  else if (k === 'r') { ui.status.clear(); checkAll(); }
  else if (k === 'u' && a) updateOne(a).then(async (ok) => { if (ok) { await rescan(); say(`${a.title} mis à jour. /reload en jeu.`); } else draw(); });
  else if (k === 'U') updateAll();
  else if (k === 'o' && a) { const url = pageOf(a); if (url) open(url); else say('Pas de page connue pour cet addon.'); }
  else if (k === 'l' && a) toggleLink(a);
  else if (k === 'a') ui.prompt = { label: 'Ajouter (lien CurseForge, numéro de projet ou owner/repo GitHub) :', value: '', submit: add };
  else if (k === 'd' && a) {
    if (a.local) say('Addon perso (lien) : à retirer à la main.');
    else ui.prompt = { label: `Supprimer ${a.title} (${a.dirs.join(', ')}) ?`, confirm: async () => {
      try { await core.remove(a); ui.status.delete(a.name); await rescan(); say(`${a.title} supprimé.`); }
      catch (e) { say(c.red(`Échec : ${e.message}`)); }
    } };
  }
  draw();
}

// ---- lifecycle ----------------------------------------------------------------------------

let endSplash = () => {};

function quit() {
  out.write(`${ESC}?25h${ESC}?1049l`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

export async function run() {
  if (!process.stdin.isTTY) throw new Error('la TUI demande un terminal (sinon : wam check / wam update)');
  out.write(`${ESC}?1049h${ESC}?25l${ESC}H${ESC}2J`);
  process.on('uncaughtException', (e) => { out.write(`${ESC}?25h${ESC}?1049l`); console.error(e); process.exit(1); });
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onKey);
  out.on('resize', () => { out.write(`${ESC}2J`); draw(); });
  // Splash for 1.6 s (any key skips it) while the addons are read; the gradient slides.
  const anim = setInterval(() => { ui.phase += 0.04; draw(); }, 50);
  endSplash = () => { if (!ui.splash) return; ui.splash = false; clearInterval(anim); ui.phase = 0; out.write(`${ESC}2J`); draw(); };
  setTimeout(() => endSplash(), 1600);
  draw();
  await rescan();
  if (!curse.hasKey()) ui.msg = c.dim('Pas de clé CurseForge : la recherche est désactivée (`wam key`).');
  await catalog.load();
  ensureCatalog();
  checkAll();
}
