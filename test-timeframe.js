// The timeframe the BOT trades on: saved/persistent, changes only when asked, and the dashboard switch really re-subscribes the feed
// (checked against a real server process: nothing about the exchange or TradingView is needed). Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execFileSync } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-tf-'));
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseEnv = (extra = {}) => { const e = { ...process.env, DATA_DIR: tmp, CONFIG_OVERRIDES_FILE: path.join(tmp, 'c.json'), STATE_FILE: path.join(tmp, 's.json'), EVENT_LOG: path.join(tmp, 'e.log'), TRADE_LOG: path.join(tmp, 't.jsonl'), TRIALS_FILE: path.join(tmp, 'tr.json'), TELEGRAM_SETTINGS_FILE: path.join(tmp, 'tg.json'), MODE: 'signal', ...extra }; delete e.TIMEFRAME; delete e.TELEGRAM_TOKEN; delete e.TELEGRAM_CHAT_ID; if (extra.TIMEFRAME) e.TIMEFRAME = extra.TIMEFRAME; return e; };
const probe = (envExtra, file) => {
  const f = path.join(tmp, 'p-' + Math.random().toString(36).slice(2) + '.json');
  if (file !== undefined) fs.writeFileSync(f, JSON.stringify(file));
  return execFileSync(process.execPath, ['-e', "console.log(require('./config').timeframe)"], { env: baseEnv({ ...envExtra, CONFIG_OVERRIDES_FILE: f }), cwd: __dirname }).toString().trim();
};
const call = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const rq = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch { return null; } })() })); });
  rq.on('error', reject); if (data) rq.write(data); rq.end();
});

(async () => {
  // precedence: saved from the dashboard > TIMEFRAME in .env > 15
  ok(probe({}) === '15', 'nothing set -> 15 minutes');
  ok(probe({ TIMEFRAME: '60' }) === '60', 'TIMEFRAME=60 in .env -> 1 hour');
  ok(probe({ TIMEFRAME: '60' }, { timeframe: '240' }) === '240', 'a timeframe saved from the dashboard beats .env');
  ok(probe({ TIMEFRAME: '60' }, { timeframe: '7' }) === '60', 'a nonsense saved value is ignored');

  // setTimeframe + persistence (in this process)
  Object.assign(process.env, baseEnv({ CONFIG_OVERRIDES_FILE: path.join(tmp, 'own.json') }));
  const cfg = require('./config'), overrides = require('./config-overrides');
  ok(cfg.TIMEFRAMES.includes('15') && overrides.setTimeframe('7').ok === false && cfg.timeframe === '15', 'an unknown timeframe is refused and nothing changes');
  ok(overrides.setTimeframe('60').ok && cfg.timeframe === '60' && JSON.parse(fs.readFileSync(process.env.CONFIG_OVERRIDES_FILE, 'utf8')).timeframe === '60', 'a valid timeframe is applied at once and saved to disk');
  overrides.apply({ risk: { atrMult: 2.5 } });
  ok(JSON.parse(fs.readFileSync(process.env.CONFIG_OVERRIDES_FILE, 'utf8')).timeframe === '60', 'applying strategy settings later does not lose the saved timeframe');
  overrides.reset();
  ok(JSON.parse(fs.readFileSync(process.env.CONFIG_OVERRIDES_FILE, 'utf8')).timeframe === '60' && overrides.isApplied() === false, '"reset strategy settings" leaves the bot timeframe alone');
  const bot = require('./bot');
  bot.setLastBar('X:Y', 123); bot.resetLastBars();
  ok(bot.getLastBar('X:Y') === undefined, 'after a switch the remembered "last evaluated candle" times are forgotten (cold start on the new timeframe)');

  // a real server
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: baseEnv({ PORT: String(port), CONFIG_OVERRIDES_FILE: path.join(tmp, 'srv.json'), SYMBOLS: 'BINANCE:BTCUSDT' }), stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await call(port, 'GET', '/api/timeframe')).status === 200; } catch {} }
    ok(up, 'the server starts');
    let r = await call(port, 'GET', '/api/timeframe');
    ok(r.json.timeframe === '15' && r.json.options.includes('60'), 'GET /api/timeframe: the bot runs on 15, options listed');
    r = await call(port, 'POST', '/api/timeframe', { tf: '60' });
    ok(r.status === 200 && r.json.changed === true && r.json.timeframe === '60', 'POST: switching to 60 works');
    ok((await call(port, 'GET', '/api/timeframe')).json.timeframe === '60' && JSON.parse(fs.readFileSync(path.join(tmp, 'srv.json'), 'utf8')).timeframe === '60', 'the new timeframe is what the server now reports, and it is saved');
    r = await call(port, 'POST', '/api/timeframe', { tf: '60' });
    ok(r.json.changed === false, 'asking for the same timeframe changes nothing');
    r = await call(port, 'POST', '/api/timeframe', { tf: '7' });
    ok(r.status === 400, 'an invalid timeframe is rejected');
    ok((await call(port, 'GET', '/api/meta')).json.timeframe === '60', 'the backtest tab (meta) also sees the new timeframe');
  } finally { srv.kill(); }
  console.log(`\n${n} timeframe checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
