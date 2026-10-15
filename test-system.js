// ccxt status check + install guards (no network, nothing is really installed). Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const sc = require('./system-check');
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-sys-'));
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ optionalDependencies: { ccxt: '4.5.84' } }));
ok(sc.wantedVersion(tmp) === '4.5.84', 'reads the pinned ccxt version from package.json');
ok(sc.wantedVersion() === JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).optionalDependencies.ccxt && /^\d+\.\d+\.\d+$/.test(sc.wantedVersion()), 'the real package.json pins ccxt to an exact version');
let st = sc.ccxtStatus(tmp);
ok(st.installed === false && st.version === null && st.wanted === '4.5.84', 'no node_modules/ccxt -> reported as not installed');
fs.mkdirSync(path.join(tmp, 'node_modules', 'ccxt'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'node_modules', 'ccxt', 'package.json'), JSON.stringify({ version: '4.5.84' }));
st = sc.ccxtStatus(tmp);
ok(st.installed === false, 'a ccxt folder that cannot be loaded (half-finished install) is reported as NOT installed');
fs.writeFileSync(path.join(tmp, 'node_modules', 'ccxt', 'package.json'), JSON.stringify({ version: '4.5.84', main: 'index.js' }));
fs.writeFileSync(path.join(tmp, 'node_modules', 'ccxt', 'index.js'), 'module.exports = {};');
st = sc.ccxtStatus(tmp);
ok(st.installed === true && st.version === '4.5.84', 'node_modules/ccxt present -> installed, with its version');
fs.writeFileSync(path.join(tmp, 'node_modules', 'ccxt', 'package.json'), JSON.stringify({ version: '4.5.99', main: 'index.js' })); // another version number: the check is remembered per version
fs.writeFileSync(path.join(tmp, 'node_modules', 'ccxt', 'index.js'), "throw new Error('require() of ES Module x not supported')");
st = sc.ccxtStatus(tmp);
ok(st.installed === false && st.loadable === false && st.error.includes(process.version) && st.error.includes('not supported'), 'installed but NOT loadable on this Node (like ccxt 4.5.59+ on Node 18) -> reported as not working, with the reason');
fs.writeFileSync(path.join(tmp, 'node_modules', 'ccxt', 'package.json'), JSON.stringify({ version: '4.5.84', main: 'index.js' }));
fs.writeFileSync(path.join(tmp, 'node_modules', 'ccxt', 'index.js'), 'module.exports = {};');
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ optionalDependencies: { ccxt: 'latest; rm -rf /' } }));
const r = sc.installCcxt(tmp);
ok(r.started === false && /no pinned/.test(r.reason), 'a version that is not plain x.y.z is never passed to npm');
fs.writeFileSync(path.join(tmp, 'package.json'), '{}');
ok(sc.installCcxt(tmp).started === false, 'no pinned version at all -> nothing is started');
// start.bat: one stray ")" inside an ( ... ) block makes cmd quit at once, so the window flashes and closes. Check the file statically.
{
  const raw = fs.readFileSync(path.join(__dirname, 'start.bat'), 'utf8');
  ok(/\r\n/.test(raw) && !/[^\r]\n/.test(raw), 'start.bat has Windows (CRLF) line endings');
  let depth = 0; const bad = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (/^rem\b/i.test(t)) return;
    const clean = t.replace(/\^[()]/g, '').replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
    const o = (clean.match(/\(/g) || []).length, c = (clean.match(/\)/g) || []).length;
    if (depth > 0 && /^echo\b/i.test(t) && (o || c)) bad.push(`line ${i + 1}: ${t}`);
    depth += o - c;
    if (depth < 0) bad.push(`line ${i + 1}: extra ")"`);
  });
  ok(bad.length === 0 && depth === 0, 'start.bat: every parenthesis inside a block is escaped and balanced' + (bad.length ? ' -> ' + bad.join(' | ') : ''));
}
console.log(`\n${n} system-check checks passed`);
