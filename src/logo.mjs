// Addon logos as blocks of colour: each terminal cell shows two pixels stacked ("▀", top
// pixel in the foreground colour, bottom one in the background), so pixels come out square.
//
// No image library: macOS `sips` turns the PNG/JPEG into a BMP at most 64 px wide or high,
// which is read here. Kept in ~/.config/wam/logos/<key>.bin (w, h, then RGBA), or an empty
// file when the addon has no logo, so each is fetched once.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DIR, UA } from './config.mjs';

const run = promisify(execFile);
const CACHE = join(DIR, 'logos');
const MAX = 64;
const mem = new Map(); // key -> image | null (none) | 'loading'

const file = (key) => join(CACHE, `${key.replace(/[^\w.-]/g, '_')}.bin`);

// The logo for key if known: an image, null when there is none, undefined while it loads.
// resolveUrl() gives its URL (or null); onReady() runs once it is loaded.
export function get(key, resolveUrl, onReady) {
  const v = mem.get(key);
  if (v === 'loading') return undefined;
  if (v !== undefined) return v;
  mem.set(key, 'loading');
  load(key, resolveUrl).catch(() => null).then((img) => { mem.set(key, img); onReady(); });
  return undefined;
}

async function load(key, resolveUrl) {
  const f = file(key);
  if (existsSync(f)) return decode(await readFile(f));
  const url = await resolveUrl();
  let img = null;
  if (url) {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(`logo : HTTP ${r.status}`); // not cached: retried next launch
    img = await convert(Buffer.from(await r.arrayBuffer()));
  }
  mkdirSync(CACHE, { recursive: true });
  await writeFile(f, img ? encode(img) : Buffer.alloc(0));
  return img;
}

async function convert(bytes) {
  const tmp = await mkdtemp(join(tmpdir(), 'wam-logo-'));
  try {
    await writeFile(join(tmp, 'in'), bytes);
    await run('sips', ['-s', 'format', 'bmp', '-Z', String(MAX), join(tmp, 'in'), '--out', join(tmp, 'out.bmp')]);
    return readBmp(await readFile(join(tmp, 'out.bmp')));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Uncompressed 24- or 32-bit BMP (what sips writes), bottom-up or top-down.
function readBmp(b) {
  if (b.toString('latin1', 0, 2) !== 'BM') throw new Error('pas un BMP');
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hh = b.readInt32LE(22), bpp = b.readUInt16LE(28);
  if (bpp !== 24 && bpp !== 32) throw new Error(`BMP ${bpp} bits`);
  const h = Math.abs(hh), stride = Math.ceil((bpp * w) / 32) * 4, n = bpp / 8;
  const px = new Uint8Array(w * h * 4);
  let anyAlpha = false;
  for (let y = 0; y < h; y++) {
    const row = off + (hh < 0 ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const i = row + x * n, o = (y * w + x) * 4;
      px[o] = b[i + 2]; px[o + 1] = b[i + 1]; px[o + 2] = b[i];
      px[o + 3] = n === 4 ? b[i + 3] : 255;
      if (n === 4 && b[i + 3]) anyAlpha = true;
    }
  }
  if (n === 4 && !anyAlpha) for (let o = 3; o < px.length; o += 4) px[o] = 255; // alpha unused
  return { w, h, px };
}

const encode = ({ w, h, px }) => Buffer.concat([Buffer.from([w, h]), Buffer.from(px)]);
const decode = (b) => (b.length > 2 ? { w: b[0], h: b[1], px: new Uint8Array(b.subarray(2)) } : null);

// Average of the source pixels under a destination pixel (downscale), alpha-weighted.
function sample(img, x0, y0, x1, y1) {
  let r = 0, g = 0, bl = 0, a = 0, n = 0;
  for (let y = Math.floor(y0); y < Math.max(Math.floor(y0) + 1, Math.ceil(y1)); y++) {
    for (let x = Math.floor(x0); x < Math.max(Math.floor(x0) + 1, Math.ceil(x1)); x++) {
      const o = (Math.min(img.h - 1, y) * img.w + Math.min(img.w - 1, x)) * 4, al = img.px[o + 3];
      r += img.px[o] * al; g += img.px[o + 1] * al; bl += img.px[o + 2] * al; a += al; n++;
    }
  }
  return a ? [Math.round(r / a), Math.round(g / a), Math.round(bl / a), a / n] : [0, 0, 0, 0];
}

// Lines of half-block cells filling a fixed size x size pixel box (size/2 lines): the image
// keeps its proportions and is centred, so every logo takes the same room.
// fg(rgb) / bg(rgb) give the escape for a colour, reset clears both.
export function render(img, size, { fg, bg, reset }) {
  const scale = Math.min(size / img.w, size / img.h);
  const w = Math.max(1, Math.round(img.w * scale)), h = Math.max(1, Math.round(img.h * scale));
  const ox = Math.floor((size - w) / 2), oy = Math.floor((size - h) / 2) & ~1; // even: whole cells
  const sx = img.w / w, sy = img.h / h;
  const px = (x, y) => {
    x -= ox; y -= oy;
    return x < 0 || y < 0 || x >= w || y >= h ? [0, 0, 0, 0] : sample(img, x * sx, y * sy, (x + 1) * sx, (y + 1) * sy);
  };
  const lines = [];
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const t = px(x, y), b = px(x, y + 1), ton = t[3] > 0.5, bon = b[3] > 0.5;
      if (ton && bon) line += fg(t) + bg(b) + '▀';
      else if (ton) line += reset + fg(t) + '▀';
      else if (bon) line += reset + fg(b) + '▄';
      else line += reset + ' ';
    }
    lines.push(line + reset);
  }
  return lines;
}
