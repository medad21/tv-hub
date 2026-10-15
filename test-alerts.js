// Safety + Telegram checks, no network: crash-safe file writes, an unreadable state file, the retrying Telegram queue,
// the new commands (/positions /pnl /close), the daily summary and the feed-watchdog decision. Run: npm test
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-alerts-'));
const STATE = path.join(tmp, 's.json');
Object.assign(process.env, {
  MODE: 'paper', STATE_FILE: STATE, EVENT_LOG: path.join(tmp, 'e.log'), DATA_DIR: tmp,
  CONFIG_OVERRIDES_FILE: path.join(tmp, 'c.json'), TELEGRAM_TOKEN: 'TESTTOKEN', TELEGRAM_CHAT_ID: '42',
});

// fake Telegram: `script` = what the next calls do ('ok' | 'net' | 'err500' | {status, body}); every sent text is logged
const calls = []; let script = [];
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
global.fetch = async (url, opt) => {
  calls.push(JSON.parse(opt.body).text);
  const step = script.shift() || 'ok';
  if (step === 'net') throw new Error('ECONNRESET');
  if (step === 'err500') return resp(500, { ok: false, description: 'Internal Server Error' });
  if (step === 'ok') return resp(200, { ok: true });
  return resp(step.status, step.body);
};

const quiet = (fn) => { const e = console.error; console.error = () => {}; return Promise.resolve(fn()).finally(() => { console.error = e; }); };
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const fresh = () => { for (const m of ['./bot', './telegram', './summary']) delete require.cache[require.resolve(m)]; return require('./bot'); }; // = restart
const SYM = 'BINANCE:BTCUSDT';
const tmpLeft = () => fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'));

(async () => {
  // ---- crash-safe writes ----
  const { atomicWrite } = require('./fsutil');
  const f = path.join(tmp, 'a.json');
  atomicWrite(f, 'one'); atomicWrite(f, 'two');
  ok(fs.readFileSync(f, 'utf8') === 'two' && tmpLeft().length === 0, 'atomic write: replaces the file and leaves no temp file behind');
  const realRename = fs.renameSync; let threw = false;
  fs.renameSync = () => { throw new Error('power cut'); };
  try { atomicWrite(f, 'three'); } catch { threw = true; } finally { fs.renameSync = realRename; }
  ok(threw && fs.readFileSync(f, 'utf8') === 'two' && tmpLeft().length === 0, 'atomic write: if the write is cut short the old complete file is still there (old code: half-written file)');

  // ---- unreadable state.json must not silently forget positions ----
  fs.writeFileSync(STATE, '{"mode":"paper","cash":9000,"positions":{"BINANCE:BTC'); // truncated mid-write
  let bot = await quiet(() => fresh());
  let p = bot.portfolio();
  ok(p.halted && p.haltReason.includes('فایل وضعیت') && bot.startupNote() && /unreadable/.test(bot.startupNote()), 'truncated state file: app starts HALTED with an explanation instead of an empty "all clear" state');
  ok(fs.readdirSync(tmp).some((x) => x.startsWith('s.json.corrupt-')), 'truncated state file: the bad file is kept aside for inspection');
  const e = await bot.signal({ symbol: SYM, side: 'buy', price: 100, atr: 4, trendOk: true });
  ok(e && e.side === 'skip' && bot.portfolio().positions.length === 0, 'while halted no new position is opened');
  bot.setHalt(false);
  ok(!bot.portfolio().halted, 'pressing Resume (setHalt false) clears the halt');
  fs.writeFileSync(STATE, ''); // zero-byte file: the classic result of a non-atomic write
  bot = await quiet(() => fresh());
  ok(bot.portfolio().halted && bot.startupNote(), 'empty state file is treated the same way');
  bot.setHalt(false);

  // ---- Telegram queue: order, retries, permanent errors ----
  const notifier = require('./notify'); notifier._setDelays([1, 1, 1]);
  await notifier.flush(500); calls.length = 0;
  script = ['net', 'err500', 'ok', 'ok'];
  const [a, b] = await Promise.all([notifier.send('A'), notifier.send('B')]);
  ok(a && b && calls.join() === 'A,A,A,B', 'telegram: network error and HTTP 500 are retried, and message B waits so the order is kept (A,A,A,B)');
  calls.length = 0; script = [{ status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } }];
  ok(await quiet(() => notifier.send('C')) === false && calls.length === 1, 'telegram: a permanent error (403 bot blocked / wrong token) is reported and NOT retried');
  calls.length = 0; script = [{ status: 429, body: { ok: false, parameters: { retry_after: 0 } } }, 'ok'];
  ok(await notifier.send('D') === true && calls.length === 2, 'telegram: rate limit (429) is retried');
  calls.length = 0; script = [{ status: 200, body: { ok: false, description: 'chat not found' } }];
  ok(await quiet(() => notifier.send('E')) === false && calls.length === 1, 'telegram: an answer with ok:false counts as a failure (old code never looked at the answer)');
  calls.length = 0; script = ['net', 'net', 'net', 'net'];
  ok(await quiet(() => notifier.send('F')) === false && calls.length === 4, 'telegram: gives up after the retries instead of retrying forever');
  calls.length = 0; await notifier.send('x'.repeat(5000));
  ok(calls[0].length <= 4000, 'telegram: over-long text is shortened (Telegram rejects > 4096 characters)');
  calls.length = 0; const tok = process.env.TELEGRAM_TOKEN; delete process.env.TELEGRAM_TOKEN;
  ok(await notifier.send('G') === false && calls.length === 0, 'telegram: not configured -> nothing is sent, nothing breaks');
  process.env.TELEGRAM_TOKEN = tok;

  // ---- commands ----
  fs.rmSync(STATE, { force: true });
  bot = fresh();
  const tg = require('./telegram');
  await bot.signal({ symbol: SYM, side: 'buy', price: 100, atr: 4, trendOk: true });
  await bot.signal({ symbol: 'OKX:BTCUSDT', side: 'buy', price: 100, atr: 4, trendOk: true });
  ok(bot.portfolio().positions.length === 2, 'setup: two open positions, same ticker on two exchanges');
  let r = await tg.handle('/positions');
  ok(r.includes(SYM) && r.includes('OKX:BTCUSDT') && r.includes('حد ضرر') && r.includes('/close'), '/positions lists each position with entry, stop and target');
  r = await tg.handle('/close', ['btcusdt']);
  ok(/چند پوزیشن/.test(r) && bot.portfolio().positions.length === 2, '/close with an ambiguous ticker closes nothing and asks for the full name');
  ok(/پیدا نشد/.test(await tg.handle('/close', ['NOPE'])) && /مثال/.test(await tg.handle('/close', [])), '/close with an unknown or missing symbol explains instead of guessing');
  await bot.tick({ symbol: 'OKX:BTCUSDT', price: 102 });
  r = await tg.handle('/close', ['okx:btcusdt']);
  ok(/بسته شد/.test(r) && bot.portfolio().positions.length === 1 && bot.portfolio().positions[0].symbol === SYM, '/close OKX:BTCUSDT closes exactly that position');
  r = await tg.handle('/pnl');
  ok(/۲۴ ساعت: [+-]\d+\.\d\d\s+\(1 معامله/.test(r) && /کل:/.test(r), '/pnl reports closed trades for 24h / 7d / 30d / all');
  ok(/\/positions \/pnl \/close/.test(await tg.handle('/help')), 'help lists the new commands');

  // ---- daily summary ----
  const summary = require('./summary');
  const hs = summary.hourSetting;
  ok(hs(undefined) === 20 && hs('') === 20 && hs('off') === null && hs('7') === 7 && hs('0') === 0 && hs('25') === 20 && hs('abc') === 20, 'summary hour: default 20 UTC, "off" disables, bad values fall back to the default');
  const port = { equity: 10123.456, dayPnlPct: 0.8, drawdownPct: 1.2, halted: false, positions: [{ symbol: SYM, pnlPct: 1.2 }] };
  const rep = { summary: { n: 3, wins: 2, losses: 1, net: 12.3 }, signals: { buy: 4, sell: 3, skipped: 9, skipReasons: [{ reason: 'trend filter', n: 5 }] } };
  let t = summary.build({ portfolio: port, report: rep, mode: 'paper', date: '2026-10-06' });
  ok(t.includes('10123.46') && t.includes('BTCUSDT +1.20٪') && t.includes('برد 2 / باخت 1') && t.includes('خالص +12.30'), 'summary text: equity, trades, open positions and signal counts');
  t = summary.build({ portfolio: port, report: rep, mode: 'signal', date: '2026-10-06' });
  ok(!t.includes('سرمایه') && t.includes('رایج‌ترین دلیل ردشدن: trend filter (5×)'), 'summary in signal mode: no fake equity, shows signals and the top skip reason');
  calls.length = 0; await notifier.flush(500);
  ok(summary.check(new Date('2026-10-07T10:00:00Z'), 20) === false, 'summary: not sent before the chosen hour');
  ok(summary.check(new Date('2026-10-07T21:00:00Z'), 20) === true, 'summary: sent after the hour');
  await notifier.flush(500);
  ok(calls.some((x) => x.includes('خلاصه‌ی روز 2026-10-07')), 'summary: it reached Telegram');
  ok(summary.check(new Date('2026-10-07T23:00:00Z'), 20) === false, 'summary: only once per day');
  bot = fresh();
  ok(bot.getSummaryDay() === '2026-10-07', 'summary: "already sent today" survives a restart');

  // ---- feed watchdog decision ----
  const { feedAction: fa } = require('./watchdog');
  ok(fa({ now: 60e3, lastUpdate: 0, warned: false }) === null, 'watchdog: 1 min of silence -> nothing');
  ok(fa({ now: 200e3, lastUpdate: 0, warned: false }) === 'warn' && fa({ now: 200e3, lastUpdate: 0, warned: true }) === null, 'watchdog: warns once after 3 min');
  ok(fa({ now: 310e3, lastUpdate: 0, warned: true }) === 'restart', 'watchdog: restarts after 5 min');
  ok(fa({ now: 30e3, lastUpdate: 0, warned: true }) === 'recovered' && fa({ now: 100e3, lastUpdate: 0, warned: true }) === null, 'watchdog: "recovered" only once the feed is really back');

  await notifier.flush(500);
  console.log(`\n${n} safety/alert checks passed`);
  process.exit(0);
})().catch((err) => { console.error('FAIL:', err.stack || err.message); process.exit(1); });
