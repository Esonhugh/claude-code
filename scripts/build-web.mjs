// Builds the `claude web` front end (web/) with Vite and writes
// web/dist/assets.json, which src/web/assets.ts imports so the CLI bundle and
// the single-file binary carry the page without any files on disk.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(projectDir, 'web');
const distDir = path.join(webDir, 'dist');

const TEXT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};
// KaTeX's @font-face rules list woff2 before woff and ttf. Every browser that
// runs this page's ES modules picks woff2, so the fallbacks are never fetched.
const UNUSED_FONT_FALLBACKS = new Set(['.woff', '.ttf']);
const BINARY_TYPES = {
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

export async function buildWeb() {
  const { build } = await import('vite');
  await build({
    configFile: path.join(webDir, 'vite.config.ts'),
    root: webDir,
    logLevel: 'warn',
  });

  const assets = {};
  for (const file of listFiles(distDir)) {
    if (path.basename(file) === 'assets.json') continue;
    const ext = path.extname(file);
    if (UNUSED_FONT_FALLBACKS.has(ext)) continue;
    const urlPath = '/' + path.relative(distDir, file).split(path.sep).join('/');
    if (TEXT_TYPES[ext]) {
      assets[urlPath] = { type: TEXT_TYPES[ext], text: fs.readFileSync(file, 'utf8') };
    } else if (BINARY_TYPES[ext]) {
      assets[urlPath] = { type: BINARY_TYPES[ext], base64: fs.readFileSync(file).toString('base64') };
    } else {
      throw new Error(`claude web: no content type for ${urlPath}`);
    }
  }
  if (!assets['/index.html']) throw new Error('claude web: Vite produced no index.html');
  fs.writeFileSync(path.join(distDir, 'assets.json'), JSON.stringify(assets));
  return assets;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const assets = await buildWeb();
  const bytes = Object.values(assets).reduce(
    (sum, a) => sum + (a.text?.length ?? Math.floor((a.base64.length * 3) / 4)),
    0,
  );
  console.log(`claude web: ${Object.keys(assets).length} files, ${(bytes / 1024).toFixed(0)} KiB -> web/dist/assets.json`);
}
