// "Is the exchange library installed, and can it be installed without a terminal?" — used by the dashboard's status line and start.bat.
// ccxt is what talks to crypto exchanges for REAL orders. It is an optional dependency: signal and paper modes never need it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const wantedVersion = (root = __dirname) => {
  try { const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); return (p.optionalDependencies || {}).ccxt || (p.dependencies || {}).ccxt || null; } catch { return null; }
};
// Installed AND loadable with the Node that is running this program. (Some ccxt releases install fine but cannot be loaded on older
// Node versions — e.g. ccxt 4.5.59+ needs Node 20.19+/22.12+ — so "the folder exists" is not good enough.)
const loadCache = new Map(); // `${root}|${version}|${node}` -> { ok, error }
function loadCheck(root, version) {
  const key = `${root}|${version}|${process.version}`;
  if (!loadCache.has(key)) {
    const r = require('child_process').spawnSync(process.execPath, ['-e', "require('ccxt')"], { cwd: root, timeout: 60000, encoding: 'utf8' });
    const err = String(r.stderr || '').split('\n').find((l) => /error|cannot|not supported|not defined/i.test(l)) || '';
    loadCache.set(key, r.status === 0 ? { ok: true, error: '' } : { ok: false, error: (err || 'load failed').trim().slice(0, 200) });
  }
  return loadCache.get(key);
}
function ccxtStatus(root = __dirname) {
  const wanted = wantedVersion(root);
  let version;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'ccxt', 'package.json'), 'utf8')).version;
    require.resolve('ccxt', { paths: [root] }); // a half-finished install (folder there, but not resolvable) counts as NOT installed
  } catch { return { installed: false, loadable: false, version: null, wanted, node: process.version, error: '' }; }
  const l = loadCheck(root, version);
  return { installed: l.ok, loadable: l.ok, version, wanted, node: process.version, error: l.ok ? '' : `نصب شده ولی با Node شما (${process.version}) بارگذاری نمی‌شود: ${l.error}` };
}

let installing = false, last = null;
// Runs `npm install ccxt@<the pinned version> --no-save` in the project folder (fixed arguments, nothing from the request is used).
// --no-save: it only fills node_modules, package.json and package-lock.json are left alone.
function installCcxt(root = __dirname) {
  if (installing) return { started: false, reason: 'busy' };
  const wanted = wantedVersion(root);
  if (!wanted || !/^\d+\.\d+\.\d+$/.test(wanted)) return { started: false, reason: 'no pinned ccxt version in package.json' };
  installing = true; last = null;
  let out = '';
  const win = process.platform === 'win32';
  const child = spawn('npm', ['install', `ccxt@${wanted}`, '--no-save', '--no-audit', '--no-fund'], { cwd: root, shell: win, windowsHide: true });
  const timer = setTimeout(() => { try { child.kill(); } catch {} }, 10 * 60 * 1000);
  const take = (d) => { out = (out + d.toString()).slice(-1500); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  // loadCache.clear() below: a fresh install must be checked again
  const done = (ok, msg) => { clearTimeout(timer); installing = false; loadCache.clear(); const st = ok ? ccxtStatus(root) : { installed: false, error: '' }; last = { ok: ok && st.installed, message: msg || st.error || out.trim().split('\n').slice(-3).join(' | '), at: Date.now() }; };
  child.on('error', (e) => done(false, `npm could not start: ${e.message}`));
  child.on('close', (code) => done(code === 0));
  return { started: true };
}
const state = () => ({ installing, last });

module.exports = { ccxtStatus, wantedVersion, installCcxt, state };

// Command line use (start.bat / start.sh):  node system-check.js        -> exit 0 if ccxt is installed, 1 if not
//                                           node system-check.js install -> installs the pinned version (output shown), exit 0 on success
if (require.main === module) {
  if (process.argv[2] === 'install' && !ccxtStatus().installed) {
    const v = wantedVersion();
    if (!v || !/^\d+\.\d+\.\d+$/.test(v)) { console.error('no pinned ccxt version in package.json'); process.exit(1); }
    console.log(`Installing the exchange library ccxt ${v} (only needed for REAL crypto orders)...`);
    require('child_process').spawnSync('npm', ['install', `ccxt@${v}`, '--no-save', '--no-audit', '--no-fund'], { cwd: __dirname, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  const st = ccxtStatus();
  if (!st.installed && (st.error || process.argv[2] === 'install')) console.log(st.error || 'ccxt is not installed');
  process.exit(st.installed ? 0 : 1);
}
