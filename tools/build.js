#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');

let esbuild;
try {
  esbuild = require('esbuild');
} catch (err) {
  console.error('[build] Missing dependency: esbuild.');
  console.error('[build] Run `npm install` (or `npm install --save-dev esbuild`) and try again.');
  process.exit(1);
}
const sass = require('sass');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const outArg = process.argv.find(arg => arg.startsWith('--out='));

const isMv3 = args.has('--mv3');
const outDirName = outArg ? outArg.slice('--out='.length) : 'build';
const outDir = path.join(root, outDirName);
const minify = args.has('--minify');
const sourcemap = args.has('--sourcemap');

const srcDir = path.join(root, 'src');
const vendorDir = path.join(root, 'vendor');
const jsDir = path.join(srcDir, 'js');
const scssDir = path.join(srcDir, 'scss');
const manifestPath = path.join(
  srcDir,
  isMv3 ? 'manifest.mv3.json' : 'manifest.json'
);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function mkdirp(dir) {
  await fs.mkdir(dir, {recursive: true});
}

async function statSize(filePath) {
  let stats = await fs.stat(filePath);
  return stats.size;
}

function shouldCopyFromSrc(relPath) {
  if (!relPath) return true;
  let normalized = relPath.replace(/\\/g, '/');
  if (normalized === 'js' || normalized.startsWith('js/')) return false;
  if (normalized === 'scss' || normalized.startsWith('scss/')) return false;
  let base = path.basename(normalized);
  if (/^manifest.*\.json$/i.test(base)) return false;
  return true;
}

function shouldCopyFromVendor(relPath) {
  if (!relPath) return true;
  let normalized = relPath.replace(/\\/g, '/');
  if (normalized === 'js' || normalized.startsWith('js/')) return false;
  return true;
}

async function copyTree(sourceRoot, targetRoot, filterFn, relPath = '') {
  let sourcePath = path.join(sourceRoot, relPath);
  let entries = await fs.readdir(sourcePath, {withFileTypes: true});
  for (let entry of entries) {
    let entryRel = path.join(relPath, entry.name);
    if (!filterFn(entryRel)) continue;
    let src = path.join(sourceRoot, entryRel);
    let dst = path.join(targetRoot, entryRel);
    if (entry.isDirectory()) {
      await mkdirp(dst);
      await copyTree(sourceRoot, targetRoot, filterFn, entryRel);
    } else if (entry.isFile()) {
      await mkdirp(path.dirname(dst));
      await fs.copyFile(src, dst);
    }
  }
}

async function compileScss() {
  let entries = await fs.readdir(scssDir, {withFileTypes: true});
  for (let entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.scss')) continue;
    let src = path.join(scssDir, entry.name);
    let css = sass.compile(src, {style: 'expanded'}).css;
    let outName = entry.name.replace(/\.scss$/i, '.css');
    let dst = path.join(outDir, 'css', outName);
    await mkdirp(path.dirname(dst));
    await fs.writeFile(dst, css, 'utf8');
    console.log(`[build] css ${path.relative(root, dst)} (${formatBytes(Buffer.byteLength(css))})`);
  }
}

async function bundleJs() {
  let entries = await fs.readdir(jsDir, {withFileTypes: true});
  let targets = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => entry.name);

  for (let fileName of targets) {
    let entry = path.join(jsDir, fileName);
    let outfile = path.join(outDir, 'js', fileName);
    await mkdirp(path.dirname(outfile));
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      absWorkingDir: root,
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: [isMv3 ? 'chrome114' : 'chrome58'],
      nodePaths: [jsDir],
      sourcemap: sourcemap,
      minify: minify,
      charset: 'ascii',
      logLevel: 'silent'
    });
    let size = await statSize(outfile);
    console.log(`[build] js  ${path.relative(root, outfile)} (${formatBytes(size)})`);
  }
}

async function writeManifest() {
  let manifestRaw = await fs.readFile(manifestPath, 'utf8');
  let pkgRaw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
  let manifest = JSON.parse(manifestRaw);
  let pkg = JSON.parse(pkgRaw);
  manifest.version = pkg.version;
  let output = JSON.stringify(manifest, null, 2) + '\n';
  let dst = path.join(outDir, 'manifest.json');
  await fs.writeFile(dst, output, 'utf8');
  console.log(`[build] manifest ${path.relative(root, dst)}`);
}

async function main() {
  console.log(`[build] mode=${isMv3 ? 'mv3' : 'mv2'} out=${path.relative(root, outDir)}`);
  await fs.rm(outDir, {recursive: true, force: true});
  await mkdirp(outDir);

  await Promise.all([
    copyTree(srcDir, outDir, shouldCopyFromSrc),
    copyTree(vendorDir, outDir, shouldCopyFromVendor),
    compileScss(),
    bundleJs(),
    writeManifest()
  ]);

  console.log('[build] done');
}

main().catch((err) => {
  console.error('[build] failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
