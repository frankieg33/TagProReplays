#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const testDir = path.join(root, 'test');
const outDir = path.join(root, '.tmp-tests');
const srcJsDir = path.join(root, 'src', 'js');

async function collectSpecFiles(dir) {
  let entries = await fs.readdir(dir, {withFileTypes: true});
  let specs = [];
  for (let entry of entries) {
    let fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      specs.push(...await collectSpecFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.spec.js')) {
      specs.push(fullPath);
    }
  }
  return specs;
}

async function buildSpec(entry) {
  let rel = path.relative(testDir, entry);
  let outfile = path.join(outDir, rel);
  await fs.mkdir(path.dirname(outfile), {recursive: true});
  await esbuild.build({
    entryPoints: [entry],
    outfile: outfile,
    absWorkingDir: root,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome114'],
    nodePaths: [srcJsDir],
    sourcemap: 'inline',
    charset: 'ascii',
    logLevel: 'silent'
  });
  console.log(`[test-build] ${rel}`);
}

async function main() {
  await fs.rm(outDir, {recursive: true, force: true});
  let specs = await collectSpecFiles(testDir);
  specs.sort();
  if (!specs.length) {
    throw new Error('No test spec files found.');
  }
  for (let spec of specs) {
    await buildSpec(spec);
  }
  console.log('[test-build] done');
}

main().catch((err) => {
  console.error('[test-build] failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
