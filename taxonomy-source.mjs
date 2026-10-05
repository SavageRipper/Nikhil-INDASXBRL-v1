// Extracts the MCA Ind AS taxonomy package (Taxonomy_for_IND-AS_V1.2_31-03-2017.zip, kept as supplied) into
// .taxonomy/ (git-ignored) so the DTS loader can read it. Pure Node (zlib), no dependencies.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TAXONOMY_ZIP = path.join(ROOT, 'Taxonomy_for_IND-AS_V1.2_31-03-2017.zip');
export const TAXONOMY_DIR = path.join(ROOT, '.taxonomy');
// the package nests the DTS under 'Ind AS taxonomy/Ind AS taxonomy/'; it is extracted to .taxonomy/IndAS/ (no spaces,
// so file URLs stay plain for external processors such as Arelle)
export const PACKAGE_PREFIX = 'Ind AS taxonomy/Ind AS taxonomy/';
export const TAXONOMY_ROOT = path.join(TAXONOMY_DIR, 'IndAS');
export const ENTRY_POINT = 'in-ci-ent-2017-03-31.xsd';

export function ensureTaxonomy() {
  if (existsSync(path.join(TAXONOMY_ROOT, ENTRY_POINT))) return TAXONOMY_ROOT;
  const buf = readFileSync(TAXONOMY_ZIP);
  // end of central directory record
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Taxonomy zip: end of central directory not found');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Taxonomy zip: bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (name.split('/').includes('..')) throw new Error(`Taxonomy zip: unsafe path ${name}`);
    const lnlen = buf.readUInt16LE(local + 26), lxlen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    if (!name.startsWith(PACKAGE_PREFIX)) continue;
    const out = path.join(TAXONOMY_ROOT, name.slice(PACKAGE_PREFIX.length));
    mkdirSync(path.dirname(out), { recursive: true });
    if (method === 0) writeFileSync(out, data);
    else if (method === 8) writeFileSync(out, inflateRawSync(data));
    else throw new Error(`Taxonomy zip: unsupported compression ${method} for ${name}`);
  }
  return TAXONOMY_ROOT;
}
