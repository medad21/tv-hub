const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const TradingView = require('@mathieuc/tradingview');
const cfg = require('./config');
const { confluence, STRATEGIES } = require('./strategy');
const { detect, isStale } = require('./signal-engine');
const { SYMBOL_RE, buildCatalog } = require('./symbols');
const bot = require('./bot');
const startTelegram = require('./telegram');
const notifier = require('./notify');
const candleStore = require('./candle-store');
const summary = require('./summary');
const { feedAction } = require('./watchdog');
const runner = require('./backtest-runner');
const history = require('./backtest-history');
const overrides = require('./config-overrides');
const journal = require('./journal');
const custom = require('./custom-strategies');
custom.load(); // user-made strategies (your custom-strategies.user.js + combinations from the dashboard) join STRATEGIES before anything runs
if (!STRATEGIES[cfg.strategy.id]) console.warn(`WARNING: the active strategy "${cfg.strategy.id}" does not exist (deleted, or custom-strategies.user.js has an error) — the bot will NOT trade until you pick another one.`);

// ---------- access control ----------
const PASS = process.env.DASH_PASSWORD || '';
const LOCAL = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
if (!LOCAL && !PASS) {
  console.error(`Refusing to listen on ${cfg.host} without DASH_PASSWORD in .env (anyone could control the bot).`);
  process.exit(1);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const TOKEN = PASS ? crypto.createHmac('sha256', PASS).update('tvh-session').digest('hex') : '';
const cookieOk = (req) => {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)tvh=([a-f0-9]{64})/);
  return !!m && crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(TOKEN));
};
const fails = new Map();
function auth(req, res, next) {
  if (!PASS || cookieOk(req)) return next();
  const f = fails.get(req.ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return res.status(429).send('Too many attempts. Try again later.');
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const d = Buffer.from(h.slice(6), 'base64').toString();
    if (crypto.timingSafeEqual(sha(d.slice(d.indexOf(':') + 1)), sha(PASS))) {
      fails.delete(req.ip);
      const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader('Set-Cookie', `tvh=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`);
      return next();
    }
    f.n++; fails.set(req.ip, f);
  }
  res.set('WWW-Authenticate', 'Basic realm="TV Hub"').status(401).send('Login required');
}

// ---------- web ----------
let lastUpdate = Date.now();
const app = express();
app.get('/health', (req, res) => res.json({ ok: true, mode: cfg.mode, lastUpdateSec: Math.round((Date.now() - lastUpdate) / 1000) }));
const PUBLIC = new Set(['/manifest.json', '/icon.svg']);
app.use((req, res, next) => (PUBLIC.has(req.path) ? next() : auth(req, res, next)));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, verifyClient: (info) => !PASS || cookieOk(info.req) });

const quotes = {};
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
const broadcast = (msg) => wss.clients.forEach((c) => send(c, msg));
const pushPortfolio = () => broadcast({ type: 'portfolio', data: bot.portfolio() });

bot.subscribe((e) => broadcast({ type: 'event', data: e })); // every trade/signal, from any source

app.use(express.json());
app.post('/api/halt', (req, res) => { bot.toggleHalt(); pushPortfolio(); res.json(bot.portfolio()); });
app.post('/api/panic', async (req, res) => {
  bot.setHalt(true);
  await bot.closeAll('panic (dashboard)');
  pushPortfolio(); res.json(bot.portfolio());
});

// ---------- in-app backtest (dashboard "Backtest" tab) ----------
// Runs the real backtest engine in-process — same strategy/risk code the live bot uses.
// Only one run at a time (downloading + crunching candles for several symbols isn't cheap).
let btBusy = false;
function backtestOpts(body = {}) {
  let symbols = cfg.symbols;
  if (Array.isArray(body.symbols) && body.symbols.length) {
    symbols = [...new Set(body.symbols.map((x) => String(x).trim().toUpperCase()).filter((x) => SYMBOL_RE.test(x)))];
    if (!symbols.length) throw new Error('نماد نامعتبر است؛ قالب درست: EXCHANGE:TICKER (مثل BINANCE:BTCUSDT)');
  }
  const tf = body.tf ? String(body.tf) : cfg.timeframe;
  const candles = Number(body.candles) || 2000;
  const strategyId = STRATEGIES[body.strategyId] ? body.strategyId : undefined; // try a strategy without "applying" it
  // try staged-exit settings without "applying" them either — only include fields the request actually sent and are valid
  let partialExitOverride;
  const pe = body.partialExit;
  if (pe && typeof pe === 'object') {
    partialExitOverride = {};
    if (pe.enabled !== undefined) partialExitOverride.enabled = !!pe.enabled;
    if (Number(pe.atR) > 0) partialExitOverride.atR = Number(pe.atR);
    if (Number.isFinite(Number(pe.closePct)) && Number(pe.closePct) >= 0 && Number(pe.closePct) <= 100) partialExitOverride.closePct = Number(pe.closePct);
    if (pe.moveStopToBreakeven !== undefined) partialExitOverride.moveStopToBreakeven = !!pe.moveStopToBreakeven;
  }
  return { symbols, tf, candles, refresh: !!body.refresh, strategyId, partialExitOverride };
}
// Lets the dashboard's backtest tab pre-fill symbols/timeframe from config.js instead of
// making you type them by hand every time.
app.get('/api/meta', (req, res) => res.json({
  symbols: cfg.symbols, catalog: buildCatalog(cfg.symbols), timeframe: cfg.timeframe, risk: cfg.risk, rsi: cfg.rsi, confluence: cfg.confluence, strategy: cfg.strategy,
  strategies: Object.entries(STRATEGIES).map(([id, s]) => ({ id, name: s.name, description: s.description, custom: !!s.custom, kind: s.kind || 'builtin' })),
  overridesApplied: overrides.isApplied(),
  strategyMissing: !STRATEGIES[cfg.strategy.id],
}));

app.use('/api/custom', require('./custom-routes')(cfg)); // combinations + your own strategy file
app.use('/api/trials', require('./trials-routes')()); // the research ledger (how many ideas were tried per symbol)
app.use('/api/ai', require('./ai-routes')()); // AI key slot + plain-words -> strategy proposal (no key = the buttons just say so)

// Apply settings chosen from a sweep's "recommended" result (or any row) to the running app right away,
// and remember them for next time. Reset undoes it and goes back to config.js's hand-written defaults.
app.post('/api/backtest/sweep/apply', (req, res) => {
  const { settings } = req.body || {};
  if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'تنظیمات نامعتبر' });
  if (settings.strategy && settings.strategy.id !== undefined && !STRATEGIES[settings.strategy.id]) return res.status(400).json({ error: 'استراتژی پیدا نشد' });
  res.json({ ok: true, applied: overrides.apply(settings) });
});
// Telegram connection from the dashboard: token + chat id (+ optional HTTP proxy). The token is never sent back to the browser.
const tgSettings = require('./telegram-settings');
const tgView = () => ({ ...tgSettings.view(), enabled: notifier.enabled() });
app.get('/api/telegram', (req, res) => res.json(tgView()));
app.post('/api/telegram', (req, res) => {
  const { token, chatId, proxy } = req.body || {};
  const r = tgSettings.set({ token, chatId, proxy });
  if (!r.ok) return res.status(400).json({ error: r.error });
  startTelegram.restart(); // new token/chat/proxy: restart the command listener
  res.json(tgView());
});
app.delete('/api/telegram', (req, res) => { tgSettings.clearSaved(); startTelegram.restart(); res.json(tgView()); });
app.post('/api/telegram/test', async (req, res) => res.json(await notifier.sendNow('✅ TV Hub به تلگرام وصل است. از این به بعد هشدارها و گزارش‌ها همین‌جا می‌آیند.')));
app.post('/api/telegram/find-proxy', async (req, res) => {
  const r = await tgSettings.findProxy();
  if (r.ok) tgSettings.set({ proxy: r.proxy }); // working proxy found: save it right away (the test button can then be pressed)
  res.json({ ...r, ...tgView() });
});
app.post('/api/telegram/detect', async (req, res) => {
  startTelegram.stop(); // two getUpdates callers at once make Telegram answer "Conflict": pause the command listener while looking
  let r;
  try { r = await tgSettings.detectChat(); if (r.ok) tgSettings.set({ chatId: r.chatId }); }
  finally { startTelegram.restart(); }
  res.json({ ...r, ...tgView() });
});

// Forward evidence: real results of the bot vs the backtest of the same weeks (also runs by itself, see evidence.js) + the candle archive
const evidence = require('./evidence');
app.get('/api/evidence', (req, res) => res.json({ latest: evidence.latest(), everyDays: evidence.everyDays(), archive: candleStore.summary() }));
app.post('/api/evidence/run', async (req, res) => {
  const days = Number((req.body || {}).days);
  try { res.json(await evidence.run({ days: days >= 7 && days <= 365 ? Math.floor(days) : undefined })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// The timeframe the BOT trades on (it makes one decision per closed candle of this size). The backtest tab's timeframe is only what is being
// tested; this is what actually runs. Changing it re-subscribes every symbol on the new candle size right away (no restart).
app.get('/api/timeframe', (req, res) => res.json({ timeframe: cfg.timeframe, options: cfg.TIMEFRAMES, openPositions: (bot.portfolio().positions || []).length }));
app.post('/api/timeframe', (req, res) => {
  const tf = String((req.body || {}).tf || '').toUpperCase();
  if (tf === cfg.timeframe) return res.json({ ok: true, changed: false, timeframe: cfg.timeframe });
  const r = overrides.setTimeframe(tf);
  if (!r.ok) return res.status(400).json({ error: r.error });
  bot.resetLastBars();
  for (const [symbol, chart] of charts) { try { chart.setMarket(symbol, { timeframe: cfg.timeframe, range: 301 }); } catch (e) { console.error(`[${symbol}] timeframe switch:`, e.message); } }
  const open = (bot.portfolio().positions || []).length;
  console.log(`timeframe -> ${cfg.timeframe} (set from the dashboard), ${open} open position(s)`);
  notifier.send(`⏱ تایم‌فریم ربات عوض شد: از این به بعد هر کندل ${cfg.timeframe === 'D' ? 'روزانه' : cfg.timeframe === 'W' ? 'هفتگی' : `${cfg.timeframe} دقیقه‌ای`} بررسی می‌شود.${open ? `\n${open} پوزیشن باز با استاپ/هدف قبلی‌اش می‌ماند.` : ''}`);
  res.json({ ok: true, changed: true, timeframe: cfg.timeframe, openPositions: open });
});

// Is the exchange library (ccxt) installed? Needed only for REAL crypto orders. POST installs it from the dashboard (no terminal needed).
const sysCheck = require('./system-check');
app.get('/api/system', (req, res) => res.json({ node: process.version, mode: cfg.mode, ccxt: sysCheck.ccxtStatus(), ...sysCheck.state() }));
app.post('/api/system/install-ccxt', (req, res) => {
  if (sysCheck.ccxtStatus().installed) return res.json({ ok: true, started: false, reason: 'already installed' });
  const r = sysCheck.installCcxt();
  res.status(r.started ? 202 : 409).json({ ok: r.started, ...r });
});

// The «استاپ سمت صرافی» switch (live crypto). GET = current state, POST {enabled:boolean} = change it.
app.get('/api/live/exchange-stops', (req, res) => res.json({ enabled: cfg.live.exchangeStops !== false, mode: cfg.mode, openPositions: (bot.portfolio().positions || []).length }));
app.post('/api/live/exchange-stops', (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled باید true یا false باشد' });
  res.json({ ok: true, ...bot.setExchangeStops(enabled), mode: cfg.mode });
});
app.delete('/api/backtest/sweep/apply', (req, res) => { overrides.reset(); res.json({ ok: true }); });

// Backtests run on a worker thread (see backtest-runner.js) so the live bot never stalls while they crunch;
// progress (download n/N, sweep n/54) is pushed to the dashboard over the websocket.
async function runJob(kind, req, res) {
  if (btBusy) return res.status(409).json({ error: 'یک بک‌تست دیگر در حال اجراست' });
  btBusy = true;
  try {
    const opts = backtestOpts(req.body);
    const out = await runner.run(kind, opts, (p) => broadcast({ type: 'btprogress', data: p }));
    if (!out.error && kind === 'sweep') out.tf = opts.tf; // the timeframe this result is valid for (the dashboard offers to switch the bot to it)
    if (!out.error) out.id = history.save({ kind: kind === 'sweep' ? 'sweep' : 'backtest', opts, report: out }).id;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { btBusy = false; }
}
app.post('/api/backtest', (req, res) => runJob('backtest', req, res));
app.post('/api/backtest/sweep', (req, res) => runJob('sweep', req, res));

// "Check gold on these timeframes with these strategies and tell me the result" — one symbol, several
// timeframes x several strategies at once, each a full backtest on that timeframe's own candles, using
// default settings for each strategy. A quick survey to see where to look closer, not a tuned recommendation
// (use Sweep on whichever (timeframe, strategy) cell looks promising for that — it validates on unseen data).
app.post('/api/backtest/matrix', async (req, res) => {
  if (btBusy) return res.status(409).json({ error: 'یک بک‌تست دیگر در حال اجراست' });
  const body = req.body || {};
  const symbol = typeof body.symbol === 'string' && body.symbol.trim() ? body.symbol.trim().toUpperCase() : null;
  if (!symbol) return res.status(400).json({ error: 'یک نماد مشخص کنید' });
  const timeframes = Array.isArray(body.timeframes) && body.timeframes.length ? body.timeframes.map(String) : ['15', '60', 'D'];
  const strategies = Array.isArray(body.strategies) && body.strategies.length ? body.strategies.filter((s) => STRATEGIES[s]) : Object.keys(STRATEGIES).filter((s) => !STRATEGIES[s].custom); // custom ones only when asked for (more combinations tested = more chance one looks good by luck)
  if (!strategies.length) return res.status(400).json({ error: 'حداقل یک استراتژی انتخاب کنید' });
  const days = Math.min(Math.max(Number(body.days) || 180, 14), 1500); // the SAME calendar window is judged for every timeframe
  btBusy = true;
  try {
    const out = await runner.run('matrix', { symbol, timeframes, strategies, days, refresh: !!body.refresh, strict: body.strict !== false, holdout: Math.min(0.5, Math.max(0, Number(body.holdout) || 0)) }, (p) => broadcast({ type: 'btprogress', data: p }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { btBusy = false; }
});
app.get('/api/backtest/history', (req, res) => res.json(history.list()));
app.get('/api/backtest/history/:id', (req, res) => {
  const r = history.get(req.params.id);
  if (!r) return res.status(404).json({ error: 'یافت نشد' });
  res.json(r);
});
app.delete('/api/backtest/history', (req, res) => { history.clear(); res.json({ ok: true }); });

// ---------- report tab: performance of what the bot actually did (paper/live) ----------
const reportArgs = (q) => ({
  mode: ['signal', 'paper', 'live'].includes(q.mode) ? q.mode : cfg.mode,
  days: q.days === 'all' ? 0 : Math.min(Number(q.days) || 30, 3650),
});
app.get('/api/report', (req, res) => {
  const rep = journal.report(reportArgs(req.query));
  rep.portfolio = bot.portfolio();
  res.json(rep);
});
app.get('/api/report/trades.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tvhub-trades.csv"' });
  res.send('\ufeff' + journal.csv(reportArgs(req.query)));
});

wss.on('connection', (ws) => {
  send(ws, { type: 'snapshot', mode: cfg.mode, quotes: Object.values(quotes), events: bot.history(), portfolio: bot.portfolio() });
});
setInterval(pushPortfolio, 3000);

// ---------- market data ----------
const client = new TradingView.Client();

const charts = new Map(); // symbol -> its live chart session (kept so the timeframe can be switched without a restart)
cfg.symbols.forEach((symbol) => {
  const chart = new client.Session.Chart();
  charts.set(symbol, chart);
  chart.setMarket(symbol, { timeframe: cfg.timeframe, range: 301 }); // 300 closed candles + the forming one = the backtester's window
  chart.onError((...err) => console.error(`[${symbol}]`, ...err));

  chart.onUpdate(() => {
    const periods = chart.periods; // newest first
    if (!periods || periods.length < 4) return;
    lastUpdate = Date.now();
    const bars = periods.slice().reverse();
    const live = bars[bars.length - 1];          // the candle still forming
    const price = live.close;                     // latest traded price: used for stops/targets and as the order price
    const prevClose = bars[bars.length - 2].close;

    // Signals are read from CLOSED candles only (the forming one is dropped), exactly like the backtester —
    // no repainting inside a candle, and volume is compared like-for-like (see signal-engine.js).
    const closed = bars.slice(0, -1);
    const d = detect(closed, cfg);

    quotes[symbol] = { symbol, price, change: (price / prevClose - 1) * 100, rsi: d.rsi, signal: d.sig, time: Date.now() };
    broadcast({ type: 'quote', data: quotes[symbol] });

    bot.tick({ symbol, price }).catch((e) => console.error('tick:', e.message));

    // Act at most once per closed candle. The last evaluated candle is kept in state.json, so a restart neither
    // repeats a signal nor loses one: "is this signal new?" comes from comparing the last two closed candles.
    candleStore.merge(symbol, cfg.timeframe, closed); // archive: only candles newer than the stored ones are written (cheap), so the history keeps growing
    const seen = bot.getLastBar(symbol);
    if (seen === d.barTime) return;
    bot.setLastBar(symbol, d.barTime);
    if (seen === undefined && isStale(d.barTime, cfg.timeframe)) return; // cold start: ignore an old transition from history
    if (!d.fresh) return;

    // the raw entry/exit trigger is the strategy's; confluence() then decides whether MACD/volume agree enough to act on it.
    const sig = d.sig;
    const filtered = confluence(sig, d.extra, cfg.confluence);
    if (filtered === sig) {
      const strategyName = (STRATEGIES[cfg.strategy.id] || {}).name;
      bot.signal({ symbol, side: sig, price, atr: d.atr, trendOk: d.trendOk, strategyName, info: { timeframe: cfg.timeframe, barTime: d.barTime, rsi: d.rsi, extra: d.extra } }).catch((e) => console.error('signal:', e.message));
    } else {
      bot.logSkip(symbol, price, `confluence: سیگنال ${sig} تأیید نشد`);
    }
  });
});

// If crypto (24/7) stops updating for 5 minutes the feed is dead: exit so Docker/pm2 restarts us.
// State is on disk, so open positions are picked up again. Telegram hears about it: a warning at 3 minutes,
// "restarting" at 5, and "recovered" if the feed comes back by itself.
if (cfg.symbols.some((s) => s.startsWith('BINANCE:'))) {
  let warned = false;
  setInterval(async () => {
    const act = feedAction({ now: Date.now(), lastUpdate, warned });
    if (act === 'warn') { warned = true; notifier.send('⚠️ بیش از ۳ دقیقه است داده‌ی بازار نیامده. اگر به ۵ دقیقه برسد برنامه خودش را ری‌استارت می‌کند.'); }
    else if (act === 'recovered') { warned = false; notifier.send('✅ داده‌ی بازار برگشت.'); }
    else if (act === 'restart') {
      console.error('watchdog: no market data for 5 min, exiting');
      notifier.send('🔄 ۵ دقیقه داده‌ای نیامد؛ برنامه ری‌استارت می‌شود (پوزیشن‌ها از state.json برمی‌گردند).');
      await notifier.flush(4000);
      process.exit(2);
    }
  }, 30000);
}
process.on('uncaughtException', async (e) => {
  console.error('uncaught:', e);
  notifier.send(`🛑 خطای پیش‌بینی‌نشده؛ برنامه می‌افتد و ری‌استارت می‌شود: ${e && e.message ? e.message : e}`);
  await notifier.flush(3000);
  process.exit(1);
});
process.on('unhandledRejection', (e) => console.error('unhandled:', e));

server.listen(cfg.port, cfg.host, () => {
  console.log(`TV Hub  http://${cfg.host}:${cfg.port}   mode=${cfg.mode}   symbols=${cfg.symbols.length}${PASS ? '   password ON' : ''}`);
  if (cfg.mode === 'live') console.log(`Live exchanges with API keys: ${bot.liveExchanges().join(', ') || 'none (signal only)'}`);
  if (cfg.mode === 'live') console.log(`LIVE mode: real orders possible (needs LIVE_CONFIRM=YES)${process.env.EXCHANGE_TESTNET === 'YES' ? ' on TESTNET' : ''}.`);
  startTelegram();
  summary.start();
  evidence.start();
  if (cfg.mode === 'live' && !sysCheck.ccxtStatus().installed) {
    const m = 'MODE=live ولی کتابخانه‌ی صرافی (ccxt) نصب نیست: سفارش واقعی کریپتو ممکن نیست. از داشبورد (پنل «استاپ سمت صرافی») دکمه‌ی نصب را بزنید یا start.bat را دوباره اجرا کنید.';
    console.error(m); try { require('./notify').send('⚠️ ' + m); } catch {}
  }
  if (cfg.mode === 'live') bot.reconcile().then((r) => { if (r.issues.length) console.error('reconcile:', r.issues.join(' | ')); else if (r.checked) console.log(`reconcile: ${r.checked} open position(s) match the exchange/broker`); }).catch((e) => console.error('reconcile failed:', e.message));
  const p = bot.portfolio(), note = bot.startupNote();
  notifier.send(`🟢 TV Hub روشن شد | حالت ${cfg.mode} | ${cfg.symbols.length} نماد، تایم‌فریم ${cfg.timeframe} | پوزیشن باز: ${p.positions.length}${p.halted ? `\n⏸ ورود جدید متوقف است: ${p.haltReason}` : ''}${note ? `\n⚠️ ${note}` : ''}`);
});

const shutdown = async (why) => {
  client.end();
  notifier.send(`⏹ TV Hub متوقف شد (${why}).`);
  await notifier.flush(2000);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
