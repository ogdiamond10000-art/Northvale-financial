'use strict';

/**
 * Build check for Northvale Financial.
 *
 * The application ships as plain ES modules and CommonJS with no bundler, so
 * "building" means proving every shipped asset exists, parses, and that the
 * document shell references the files that are actually on disk.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const failures = [];

function walk(dir, filter) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(root, file);
}

function checkSyntax(files, asModule) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-build-'));
  try {
    files.forEach((file, index) => {
      const target = path.join(tmp, `check-${index}${asModule ? '.mjs' : '.cjs'}`);
      fs.copyFileSync(file, target);
      try {
        execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
      } catch (error) {
        failures.push(`Syntax error in ${relative(file)}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 1. Required entry points.
const required = [
  'package.json',
  'server/index.js',
  'public/index.html',
  'public/css/app.css',
  'public/js/app.js',
];
required.forEach((file) => {
  if (!fs.existsSync(path.join(root, file))) failures.push(`Missing required file: ${file}`);
});

// 2. Syntax of every server and client module.
const serverFiles = walk(path.join(root, 'server'), (file) => file.endsWith('.js'));
const clientFiles = walk(path.join(root, 'public', 'js'), (file) => file.endsWith('.js'));
checkSyntax(serverFiles, false);
checkSyntax(clientFiles, true);

// 3. The document shell must reference assets that exist.
const htmlPath = path.join(root, 'public', 'index.html');
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|svg))"/g)].map((m) => m[1]);
  refs.forEach((ref) => {
    const target = path.join(root, 'public', ref.replace(/^\//, ''));
    if (!fs.existsSync(target)) failures.push(`index.html references missing asset: ${ref}`);
  });
  if (!/id="app"/.test(html)) failures.push('index.html is missing the #app mount point.');
  if (!refs.some((ref) => ref.endsWith('.css'))) failures.push('index.html does not load a stylesheet.');
}

// 4. Every view module the shell imports must export what the shell uses.
const shell = path.join(root, 'public', 'js', 'app.js');
if (fs.existsSync(shell)) {
  const source = fs.readFileSync(shell, 'utf8');
  const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)];
  imports.forEach(([, names, spec]) => {
    if (!spec.startsWith('./')) return;
    const target = path.join(path.dirname(shell), spec);
    if (!fs.existsSync(target)) {
      failures.push(`app.js imports missing module: ${spec}`);
      return;
    }
    const body = fs.readFileSync(target, 'utf8');
    names
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .forEach((name) => {
        const pattern = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`);
        if (!pattern.test(body)) failures.push(`${spec} does not export "${name}" used by app.js`);
      });
  });
}

if (failures.length) {
  console.error('Build check failed:');
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}

console.log(
  `Build check passed: ${serverFiles.length} server modules, ${clientFiles.length} client modules, assets verified.`,
);
