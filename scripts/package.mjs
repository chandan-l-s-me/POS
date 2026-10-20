/**
 * Builds the package a shop installs: release/VyaparaBilling-<version>/ and a
 * .zip of it. The shop needs nothing else on the computer — no Node, no npm,
 * no build step — and never opens a terminal.
 *
 *   npm run package
 *
 * Layout of the package:
 *   Install Vyapara.bat / Update Vyapara.bat / Uninstall Vyapara.bat
 *   README.txt                 what to do, for whoever installs it
 *   scripts/                   the PowerShell behind the three .bat files
 *   node/node.exe              the Node.js runtime this was built and tested with
 *   service/VyaparaBilling.exe WinSW (MIT), runs the server as a Windows service
 *   app/                       the server, bundled to one file, and the built web app
 *
 * The shop's settings (.env), database and backups are never in the package:
 * the installer creates them on the shop's computer, outside the program folder.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = `VyaparaBilling-${version}`;
const OUT = path.join(ROOT, 'release', NAME);
const APP = path.join(OUT, 'app');

// WinSW 2.12.0, x64, self-contained (no .NET install needed). Kept out of git;
// fetched once into installer/vendor and checked against this digest.
const WINSW_URL = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe';
const WINSW_SHA256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da';

const step = (message) => console.log(`\n▸ ${message}`);
const copy = (from, to) => fs.cpSync(from, to, { recursive: true });

step('Building the web app (vite build)');
execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });

step(`Preparing ${path.relative(ROOT, OUT)}`);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

step('Bundling the server into one file');
await build({
  entryPoints: [path.join(ROOT, 'server.ts')],
  outfile: path.join(APP, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Native module: shipped as files. Vite: only ever loaded in development.
  external: ['better-sqlite3', 'vite'],
  // Bundled CommonJS packages (express, jsonwebtoken…) call require().
  banner: { js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
// The read workers load this file by path, next to the server.
copy(path.join(ROOT, 'db', 'read-worker.mjs'), path.join(APP, 'read-worker.mjs'));
copy(path.join(ROOT, 'dist'), path.join(APP, 'dist'));

// better-sqlite3 and what it loads at run time (prebuild-install is install-time only).
for (const pkg of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
  const from = path.join(ROOT, 'node_modules', pkg);
  const to = path.join(APP, 'node_modules', pkg);
  copy(from, to);
}
// Only the compiled module is needed from better-sqlite3's build tree.
const sqliteBuild = path.join(APP, 'node_modules', 'better-sqlite3');
for (const dir of ['deps', 'src', 'build/Release/obj', 'build/Release/.deps', 'build/deps']) {
  fs.rmSync(path.join(sqliteBuild, dir), { recursive: true, force: true });
}
for (const entry of fs.readdirSync(path.join(sqliteBuild, 'build', 'Release'))) {
  if (!entry.endsWith('.node')) fs.rmSync(path.join(sqliteBuild, 'build', 'Release', entry), { recursive: true, force: true });
}
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: 'vyapara-billing', version, private: true, type: 'module' }, null, 2));
fs.writeFileSync(path.join(APP, 'VERSION'), version);
copy(path.join(ROOT, 'installer', 'tools'), path.join(APP, 'tools'));

step('Adding the Node.js runtime');
fs.mkdirSync(path.join(OUT, 'node'));
copy(process.execPath, path.join(OUT, 'node', 'node.exe'));
fs.writeFileSync(path.join(OUT, 'node', 'VERSION'), process.version);

step('Adding the service wrapper (WinSW)');
const vendor = path.join(ROOT, 'installer', 'vendor');
const winsw = path.join(vendor, 'WinSW-x64.exe');
if (!fs.existsSync(winsw)) {
  fs.mkdirSync(vendor, { recursive: true });
  console.log(`  downloading ${WINSW_URL}`);
  const res = await fetch(WINSW_URL);
  if (!res.ok) throw new Error(`WinSW download failed: ${res.status}`);
  fs.writeFileSync(winsw, Buffer.from(await res.arrayBuffer()));
}
const digest = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(winsw)).digest('hex');
if (digest !== WINSW_SHA256) throw new Error(`WinSW checksum mismatch: ${digest}`);
fs.mkdirSync(path.join(OUT, 'service'));
copy(winsw, path.join(OUT, 'service', 'VyaparaBilling.exe'));

step('Adding the installer');
for (const file of ['Install Vyapara.bat', 'Update Vyapara.bat', 'Uninstall Vyapara.bat', 'README.txt']) {
  copy(path.join(ROOT, 'installer', file), path.join(OUT, file));
}
copy(path.join(ROOT, 'installer', 'scripts'), path.join(OUT, 'scripts'));

step('Checking the bundled server starts');
execSync(`"${path.join(OUT, 'node', 'node.exe')}" --check "${path.join(APP, 'server.mjs')}"`, { stdio: 'inherit' });

step('Zipping');
const zip = path.join(ROOT, 'release', `${NAME}.zip`);
fs.rmSync(zip, { force: true });
// Windows' own tar (bsdtar) writes standard zips; Compress-Archive in Windows
// PowerShell 5.1 fails on some files.
execSync(`"${path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')}" -a -c -f "${zip}" -C "${path.dirname(OUT)}" "${NAME}"`, { stdio: 'inherit' });
if (!fs.existsSync(zip)) throw new Error('The zip was not created.');

const size = (p) => {
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    total += entry.isDirectory() ? size(full) : fs.statSync(full).size;
  }
  return total;
};
console.log(`\n✓ ${path.relative(ROOT, OUT)} (${(size(OUT) / 1e6).toFixed(0)} MB)`);
console.log(`✓ ${path.relative(ROOT, zip)} (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`);
