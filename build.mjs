// Release/build engine: bundles the UI + core into ONE self-contained HTML file with the compiled
// authority embedded. Output works offline from file:// (fonts fall back to system faces).
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const r = (p) => path.join(ROOT, p);
const res = await build({ entryPoints: [r('app.js')], bundle: true, format: 'iife', target: 'es2020', minify: true, write: false, legalComments: 'none' });
const css = readFileSync(r('styles.css'), 'utf8');
const authority = readFileSync(r('MCA_AUTHORITY.json'), 'utf8').replace(/<\//g, '<\\/');
const shell = readFileSync(r('shell.html'), 'utf8');
// build id: content hash of everything that goes into the page (deterministic)
const raw = res.outputFiles[0].text;
const buildId = createHash('sha256').update(raw).update(css).update(authority).update(shell).digest('hex').slice(0, 10);
if (!raw.includes('__BUILD_ID__')) throw new Error('build id placeholder missing from the bundle');
const js = raw.replace(/__BUILD_ID__/g, buildId).replace(/<\/script/gi, '<\\/script');
const body = shell.replace('/*STYLES*/', () => css).replace('/*AUTHORITY*/', () => authority).replace('/*APP*/', () => js);
// fragment for hosted publishing (host supplies the document skeleton)
writeFileSync(r('artifact.html'), body);
// standalone local-first document
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
writeFileSync(r('indas-xbrl.html'), full);
// GitHub Pages entry point: the app itself
writeFileSync(r('index.html'), full);
const hash = createHash('sha256').update(full).digest('hex');
writeFileSync(r('BUILD_INFO.json'), JSON.stringify({ file: 'indas-xbrl.html', sha256: hash, bytes: Buffer.byteLength(full), authorityHash: JSON.parse(authority.replace(/<\\\//g, '</')).meta.authorityHash, buildId, builtWith: 'esbuild', node: process.version }, null, 2));
console.log(`build ${buildId} indas-xbrl.html ${(Buffer.byteLength(full) / 1e6).toFixed(2)} MB sha256=${hash.slice(0, 16)}`);
