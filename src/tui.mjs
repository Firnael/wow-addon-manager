// Full-screen terminal UI, no dependencies: raw stdin, ANSI escapes, alternate screen.
// Two views: installed addons (check, update, remove, add) and CurseForge search.

import { execFile } from 'node:child_process';
import * as core from './core.mjs';
import * as curse from './curse.mjs';

const out = process.stdout;
const ESC = '\x1b[';
const c = {
  dim: (s) => `${ESC}2m${s}${ESC}22m`, bold: (s) => `${ESC}1m${s}${ESC}22m`,
  green: (s) => `${ESC}32m${s}${ESC}39m`, yellow: (s) => `${ESC}33m${s}${ESC}39m`, red: (s) => `${ESC}31m${s}${ESC}39m`,
  cyan: (s) => `${ESC}36m${s}${ESC}39m`, inv: (s) => `${ESC}7m${s}${ESC}27m`,
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const fit = (s, w) => { s = String(s ?? ''); return s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w); };
const fmtN = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? '');
const day = (d) => (d ? String(d).slice(0, 10) : '');

const ui = {
  view: 'installed',
  addons: [], status: new Map(), sel: 0, top: 0,
  search: { query: '', input: true, results: [], sel: 0, top: 0, all: false, loading: false, done: false },
  prompt: null, // { label, value, submit(value) } or { label, confirm(yes) }
  msg: '', busy: 0,
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

// Installs a CurseForge project and its required dependencies that are missing.
async function installCurse(id, title, seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);
  const remote = await curse.latestFile(id);
  const dirs = await core.install({ curse: id }, remote, { title });
  const done = [title ?? dirs[0]];
  const have = new Set(ui.addons.map((a) => a.key));
  for (const dep of await curse.requiredDeps(id, remote.fileId)) {
    if (have.has(`curse:${dep}`)) continue;
    const m = await curse.mod(dep).catch(() => null);
    say(`Dépendance : ${m?.name ?? dep}…`);
    done.push(...await installCurse(dep, m?.name, seen));
  }
  return done;
}

// "Add" accepts a CurseForge link or project number, or a GitHub owner/repo (or its URL).
async function add(text) {
  text = text.trim();
  const gh = text.match(/^(?:https?:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git|\/.*)?$/);
  const cfSlug = text.match(/curseforge\.com\/wow\/addons\/([\w-]+)/)?.[1];
  const cfId = text.match(/^\d+$/) ? Number(text) : Number(text.match(/curseforge\.com\/projects\/(\d+)/)?.[1]) || null;
  ui.busy++; draw();
  try {
    if (cfId || cfSlug) {
      const m = cfId ? await curse.mod(cfId).catch(() => ({ id: cfId })) : await curse.bySlug(cfSlug);
      say(`Installation de ${m.name ?? m.id}…`);
      const done = await installCurse(m.id, m.name);
      say(`Installé : ${done.join(', ')}. /reload en jeu.`);
    } else if (gh && !text.includes(' ')) {
      const src = { github: gh[1], asset: 'forever.*\\.zip$' };
      say(`Recherche d'une release Forever sur ${gh[1]}…`);
      const remote = await core.latest(src);
      const dirs = await core.install(src, remote);
      say(`Installé : ${dirs.join(', ')} (${remote.name}). /reload en jeu.`);
    } else {
      say('Format non reconnu : lien CurseForge, numéro de projet ou owner/repo GitHub.');
    }
  } catch (e) { say(c.red(`Échec : ${e.message}`)); }
  ui.busy--;
  await rescan();
  ui.addons.forEach((a) => { if (!ui.status.has(a.name)) checkOne(a); });
}

async function runSearch() {
  const s = ui.search;
  if (!s.query.trim()) return;
  if (!curse.hasKey()) return say(c.yellow('La recherche demande une clé CurseForge : quitter et lancer `wam key`.'));
  s.loading = true; s.input = false; s.sel = 0; s.top = 0; draw();
  try { s.results = await curse.search(s.query.trim()); s.done = true; say(''); }
  catch (e) { s.results = []; say(c.red(`Recherche : ${e.message}`)); }
  s.loading = false; draw();
}

const visibleResults = () => ui.search.results.filter((r) => ui.search.all || r.forever);

function pageOf(a) {
  if (a?.source?.curse) return `https://www.curseforge.com/projects/${a.source.curse}`;
  if (a?.source?.github) return `https://github.com/${a.source.github}`;
  return null;
}
const open = (url) => url && execFile('open', [url]);

// ---- drawing ------------------------------------------------------------------------------

function statusCell(a) {
  const st = ui.status.get(a.name);
  switch (st?.s) {
    case 'local': return c.cyan('perso (lien)');
    case 'unknown': return c.dim('source inconnue');
    case 'checking': return c.dim('…');
    case 'busy': return c.yellow('installation…');
    case 'ok': return st.fresh ? c.green(`✓ ${st.remote.version ?? 'mis à jour'}`) : c.green('à jour');
    case 'update': return c.yellow(`↑ ${st.remote.version ?? st.remote.name}${st.remote.beta ? ' (bêta)' : ''}`);
    case 'error': return c.red(`✗ ${st.err}`);
    default: return '';
  }
}

function list(rows, sel, top, height, width) {
  const lines = [];
  for (let i = top; i < Math.min(rows.length, top + height); i++) {
    const text = rows[i];
    lines.push(i === sel ? c.inv(fit(strip(text), width)) : text);
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
  const tab = (k, label, on) => (on ? c.inv(` ${k} ${label} `) : c.dim(` ${k} ${label} `));
  L.push(`${c.bold(' WoW Forever · addons')}  ${tab(1, 'Installés', ui.view === 'installed')}${tab(2, 'Rechercher', ui.view === 'search')}`);
  L.push(c.dim('─'.repeat(W)));
  const bodyH = H - 8;

  if (ui.view === 'installed') {
    const rows = ui.addons.map((a) => {
      const name = fit(a.title, 32), ver = fit(a.version ?? '', 18);
      return ` ${name} ${c.dim(ver)} ${statusCell(a)}`;
    });
    scrollTo(ui, rows.length, bodyH);
    L.push(...list(rows, ui.sel, ui.top, bodyH, W));
    const a = ui.addons[ui.sel];
    L.push(c.dim('─'.repeat(W)));
    if (a) {
      const src = a.local ? `lien vers ${a.target}` : a.source?.curse ? `CurseForge ${a.source.curse}` : a.source?.github ? `GitHub ${a.source.github}` : 'source inconnue : a pour l\'ajouter';
      L.push(fit(` ${c.bold(a.title)}  ${c.dim(a.dirs.join(', '))}`, W + 20));
      L.push(fit(` ${a.notes ?? ''}`, W));
      L.push(c.dim(fit(` ${src}${a.installed?.at ? ` · installé le ${a.installed.at}` : ''}`, W)));
    } else L.push('', '', '');
  } else {
    const s = ui.search;
    const cursor = s.input ? c.inv(' ') : '';
    L.push(` Rechercher : ${s.query}${cursor}${s.loading ? c.dim('  recherche…') : ''}`);
    const res = visibleResults();
    const have = new Set(ui.addons.map((a) => a.key));
    const rows = res.map((r) => {
      const tags = [r.forever ? '' : c.dim('pas Forever'), have.has(`curse:${r.id}`) ? c.green('installé') : ''].filter(Boolean).join(' ');
      return ` ${fit(r.name, 34)} ${c.dim(fit(fmtN(r.downloads), 7))} ${c.dim(fit(r.author, 16))} ${tags}`;
    });
    if (!rows.length && s.done && !s.loading) rows.push(c.dim(s.results.length ? ` aucun résultat Forever (f pour tout voir, ${s.results.length})` : ' aucun résultat'));
    scrollTo(s, res.length || 1, bodyH - 1);
    L.push(...list(rows, s.input ? -1 : s.sel, s.top, bodyH - 1, W));
    const r = res[s.sel];
    L.push(c.dim('─'.repeat(W)));
    if (r && !s.input) {
      L.push(` ${c.bold(r.name)}  ${c.dim(`${fmtN(r.downloads)} téléchargements · ${r.author ?? ''} · ${day(r.updated)}`)}`);
      L.push(fit(` ${r.summary ?? ''}`, W));
      L.push(c.dim(fit(` ${r.url ?? ''}`, W)));
    } else L.push('', '', '');
  }

  L.push(ui.prompt ? ` ${c.yellow(ui.prompt.label)} ${ui.prompt.value ?? ''}${ui.prompt.confirm ? '' : c.inv(' ')}` : ` ${ui.msg}`);
  const keys = ui.prompt ? (ui.prompt.confirm ? 'o oui · n non' : 'Entrée valider · Échap annuler')
    : ui.view === 'installed'
      ? '↑↓ choisir · u mettre à jour · U tout · r vérifier · a ajouter · d supprimer · o page · Tab recherche · q quitter'
      : ui.search.input ? 'Entrée chercher · ↓ résultats · Tab installés · Échap quitter la saisie'
        : '↑↓ choisir · Entrée installer · o page · f Forever/tout · / nouvelle recherche · Tab installés · q quitter';
  L.push(c.dim(fit(` ${keys}`, W)));
  return L.slice(0, H);
}

let pending = false;
function draw() {
  if (pending) return;
  pending = true;
  setImmediate(() => {
    pending = false;
    out.write(`${ESC}H` + render().map((l) => l + `${ESC}K`).join('\r\n') + `${ESC}J`);
  });
}

// ---- keys ---------------------------------------------------------------------------------

const KEYS = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[5~': 'pgup', '\x1b[6~': 'pgdown', '\r': 'enter', '\t': 'tab', '\x7f': 'back', '\x1b': 'esc', '\x03': 'ctrl-c' };

function onKey(data) {
  const k = KEYS[data] ?? data;
  if (k === 'ctrl-c') return quit();

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
      else if (k === 'esc' || k === 'down') { if (s.results.length) s.input = false; }
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
    else if (k === 'f') { s.all = !s.all; s.sel = 0; s.top = 0; }
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
  await rescan();
  if (!curse.hasKey()) ui.msg = c.dim('Pas de clé CurseForge : la recherche est désactivée (`wam key`).');
  checkAll();
}
