// Zip extraction with node:zlib, so no `unzip` is needed (Windows has none).
// Handles stored and deflated entries, which is what addon zips hold; no Zip64, no encryption.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export async function extract(buf, outDir) {
  // End of central directory: last 22 bytes, or further back when there is a comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip illisible (pas de répertoire central)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error('zip64 non géré');
  const root = resolve(outDir);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip illisible (entrée corrompue)');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error(`${name} : entrée chiffrée`);
    const dest = resolve(root, ...name.split('/'));
    if (dest !== root && !dest.startsWith(root + sep)) throw new Error(`${name} : chemin hors du zip, refusé`);
    if (name.endsWith('/')) { await mkdir(dest, { recursive: true }); continue; }
    // Data starts after the local header, whose name and extra lengths can differ.
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`${name} : compression ${method} non gérée`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }
}
