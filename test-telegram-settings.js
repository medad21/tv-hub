// Telegram connection saved inside the program: precedence, validation, token never exposed, sending through the saved settings,
// a real HTTP proxy hop, automatic chat-id detection and restartable command listener. No real Telegram, no network.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvhub-tg-'));
Object.assign(process.env, { DATA_DIR: tmp, TELEGRAM_SETTINGS_FILE: path.join(tmp, 'tg.json'), MODE: 'paper', STATE_FILE: path.join(tmp, 's.json'), EVENT_LOG: path.join(tmp, 'e.log'), CONFIG_OVERRIDES_FILE: path.join(tmp, 'c.json') });
delete process.env.TELEGRAM_TOKEN; delete process.env.TELEGRAM_CHAT_ID; delete process.env.TELEGRAM_PROXY;
const TOKEN = '123456789:' + 'A'.repeat(35), TOKEN2 = '987654321:' + 'B'.repeat(35);
let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ok  ' + m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const S = require('./telegram-settings'), notifier = require('./notify');
  ok(!S.get().token && !notifier.enabled(), 'nothing saved and nothing in .env -> Telegram is off');

  // validation
  ok(S.set({ token: 'abc' }).ok === false && S.set({ chatId: '@my_name' }).ok === false, 'a malformed token and a @username instead of a numeric chat id are refused with a clear reason');
  const half = S.set({ token: 'B'.repeat(35) });
  ok(half.ok === false && half.error.includes('قسمت عددی'), 'only the part after the colon (number missing) -> a specific message about the missing number');
  ok(S.set({ token: ` ${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)} ` }).ok && S.get().token === TOKEN, 'a token pasted with spaces or a line break inside is accepted');
  S.clearSaved();
  ok(S.set({ proxy: 'socks5://127.0.0.1:1080' }).ok === false && S.set({ proxy: 'not a url' }).ok === false, 'SOCKS and garbage proxy addresses are refused');
  ok(!fs.existsSync(S.file()), 'a refused save writes nothing');

  // save + precedence
  ok(S.set({ token: TOKEN, chatId: '555001' }).ok && notifier.enabled() && S.get().chatId === '555001', 'saved token + chat id turn Telegram on');
  process.env.TELEGRAM_TOKEN = TOKEN2; process.env.TELEGRAM_CHAT_ID = '777';
  ok(S.get().token === TOKEN && S.get().chatId === '555001', 'a value saved from the dashboard beats the one in .env');
  ok(S.set({ token: '' }).ok && S.get().token === TOKEN2 && S.get().chatId === '555001', 'clearing a saved value lets .env apply again; the other saved values stay');
  const v = S.view();
  ok(!JSON.stringify(v).includes(TOKEN2) && !JSON.stringify(v).includes(TOKEN) && v.tokenHint === 'BBBB' && v.hasToken, 'the dashboard view never contains the token (only its last 4 characters)');
  S.set({ token: TOKEN }); delete process.env.TELEGRAM_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  S.set({ token: undefined, chatId: undefined, proxy: undefined });
  ok(S.get().token === TOKEN && S.get().chatId === '555001', 'a save that leaves a field out (undefined) keeps it');

  // sending uses the saved settings
  const calls = [];
  global.fetch = async (url, opt) => { calls.push({ url, body: JSON.parse(opt.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }; };
  ok(await notifier.send('hello') === true && calls[0].url.includes(`/bot${TOKEN}/sendMessage`) && calls[0].body.chat_id === '555001', 'alerts go out with the saved token to the saved chat');
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: 'Unauthorized' }) });
  const bad = await notifier.sendNow('x');
  ok(bad.ok === false && bad.error === 'Unauthorized', 'the test button gets the real reason (here: wrong token)');
  global.fetch = async () => { throw new Error('ECONNRESET'); };
  ok((await notifier.sendNow('x')).error.includes('ECONNRESET'), 'a network failure is reported, not swallowed');

  // chat id detection
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) });
  ok((await S.detectChat()).ok === false, 'detect: no message to the bot yet -> asks the person to send one');
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [
    { message: { chat: { id: -100, type: 'group', title: 'g' } } },
    { message: { chat: { id: 4242, type: 'private', first_name: 'Sasan', last_name: 'X' } } },
    { message: { chat: { id: 9999, type: 'private', first_name: 'Newest' } } } ] }) });
  const d = await S.detectChat();
  ok(d.ok && d.chatId === '9999' && d.name === 'Newest', 'detect: takes the newest PRIVATE chat (groups are ignored)');
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: 'Conflict: terminated by other getUpdates request' }) });
  ok((await S.detectChat()).error.includes('Conflict'), 'detect: Telegram errors are passed on');

  // a real HTTP proxy hop
  const seen = [];
  const proxy = http.createServer().on('connect', (req, sock) => { seen.push(req.url); sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  global.fetch = async () => { throw new Error('the proxy must be used, not global fetch'); };
  S.set({ proxy: `http://127.0.0.1:${proxy.address().port}` });
  const viaProxy = await S.api('getMe', {}, 5000);
  ok(seen.includes('api.telegram.org:443') && viaProxy.ok === false, 'with a proxy saved, Telegram traffic really goes through it (CONNECT api.telegram.org:443)');
  proxy.close(); S.set({ proxy: '' });

  // readable network errors (the plain message was just "fetch failed")
  const cause = (code, message = '') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });
  ok(S.describeError(cause('ENOTFOUND')).includes('DNS') && S.describeError(cause('UND_ERR_CONNECT_TIMEOUT')).includes('زمان'), 'a network failure is explained with its real cause, not just "fetch failed"');
  ok(S.describeError(cause('ECONNRESET')).includes('پیدا کردن خودکار پروکسی'), 'the explanation tells the person about the proxy finder (Node ignores the browser/Windows proxy)');
  S.set({ proxy: 'http://127.0.0.1:9' });
  ok(S.describeError(cause('ECONNREFUSED')).includes('پروکسی ذخیره‌شده'), 'with a proxy saved, a refused connection blames the proxy, not Telegram');
  S.set({ proxy: '' });

  // finding a proxy by itself
  ok(JSON.stringify(S.parseWinProxy('ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    127.0.0.1:10809')) === '["http://127.0.0.1:10809"]', 'Windows proxy setting "host:port" is read');
  ok(JSON.stringify(S.parseWinProxy('ProxyEnable    REG_DWORD    0x1', 'ProxyServer    REG_SZ    http=127.0.0.1:8080;https=127.0.0.1:8080;socks=127.0.0.1:1080')) === '["http://127.0.0.1:8080"]', 'Windows per-protocol list: http/https entries kept, socks skipped');
  ok(S.parseWinProxy('ProxyEnable    REG_DWORD    0x0', 'ProxyServer    REG_SZ    127.0.0.1:10809').length === 0, 'Windows proxy switched off -> nothing');
  const mk = (answer) => new Promise((res) => { const sv = http.createServer().on('connect', (rq, sock) => { sock.end(answer); }); sv.listen(0, '127.0.0.1', () => res(sv)); });
  const good = await mk('HTTP/1.1 200 Connection established\r\n\r\n'), notGood = await mk('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  const url = (sv) => `http://127.0.0.1:${sv.address().port}`;
  ok(await S.probeProxy(url(good)) === true && await S.probeProxy(url(notGood)) === false && await S.probeProxy('http://127.0.0.1:1') === false, 'a proxy counts as working only if it really opens a tunnel to api.telegram.org:443');
  const found = await S.findProxy([url(notGood), url(good)]);
  ok(found.ok && found.proxy === url(good), 'the finder picks the one proxy that works among several');
  good.close(); notGood.close();

  // restartable command listener
  const startTelegram = require('./telegram');
  let polls = 0;
  global.fetch = async () => { polls++; await sleep(20); return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }; };
  ok(startTelegram.restart() === true, 'the command listener starts once token + chat id are saved');
  await sleep(120); const p1 = polls;
  startTelegram.stop(); await sleep(150); const p2 = polls; await sleep(150);
  ok(p1 >= 2 && polls === p2, 'stopping it really ends the polling loop (no stray old listener keeps running)');
  S.clearSaved();
  ok(startTelegram.restart() === false && !notifier.enabled(), 'after clearing, nothing starts and Telegram is off again');
  console.log(`\n${n} telegram-settings checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
