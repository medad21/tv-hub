// Telegram sender shared by the bot, the server and the commands. Differences from a bare fetch():
//  - ONE ordered queue, so messages arrive in the order things happened;
//  - retries on network errors, HTTP 429 (honouring retry_after) and 5xx; other 4xx (wrong token, bot blocked,
//    wrong chat id) are permanent -> logged, not retried;
//  - checks Telegram's answer (fetch() only throws on network errors, not on 4xx/5xx — the old code never noticed
//    a rejected message);
//  - flush(ms) lets the server say "I am restarting" and still get the message out before exiting.
const MAX_QUEUE = 100, MAX_LEN = 4000;
let delays = [1000, 5000, 20000]; // wait before retry 1, 2, 3
const queue = [];
let current = null;

const lang = require('./lang');
const settings = require('./telegram-settings'); // token / chat id / proxy: saved from the dashboard, or from .env
const token = () => settings.get().token, chat = () => settings.get().chatId;
const enabled = () => !!(token() && chat());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(item) {
  try {
    const r = await settings.fetchFn()(`https://api.telegram.org/bot${token()}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: item.chat, text: item.text }),
    });
    let j = null; try { j = await r.json(); } catch {}
    if (r.ok && !(j && j.ok === false)) return { ok: true };
    const retryAfter = j && j.parameters && j.parameters.retry_after;
    return { ok: false, retry: r.status === 429 || r.status >= 500, retryAfter, error: (j && j.description) || `HTTP ${r.status}` };
  } catch (e) { return { ok: false, retry: true, error: e.message }; }
}

async function drain() {
  while (queue.length) {
    const item = queue[0];
    let delivered = false;
    for (let i = 0; i <= delays.length; i++) {
      const r = await attempt(item);
      if (r.ok) { delivered = true; break; }
      if (!r.retry) { console.error(`telegram: ${r.error} (not retried)`); break; }
      if (i === delays.length) { console.error(`telegram: gave up after ${i + 1} attempts: ${r.error}`); break; }
      await sleep(Math.max(delays[i], (r.retryAfter || 0) * 1000));
    }
    queue.shift();
    item.resolve(delivered);
  }
  current = null;
}

// Resolves true once delivered, false if it never was (or Telegram is not configured). Never rejects.
function send(text) {
  if (!enabled()) return Promise.resolve(false);
  let t = lang.tr(String(text));
  if (t.length > MAX_LEN) t = t.slice(0, MAX_LEN - 1) + '…';
  return new Promise((resolve) => {
    if (queue.length >= MAX_QUEUE) { const old = queue.splice(1, 1)[0]; if (old) old.resolve(false); } // keep the head (in flight), drop the oldest waiting
    queue.push({ text: t, chat: chat(), resolve });
    if (!current) current = drain();
  });
}

// Wait until everything queued has been sent, but never longer than `ms` (used right before process.exit).
const flush = (ms = 3000) => (current ? Promise.race([current, sleep(ms)]) : Promise.resolve());

// One direct attempt, no queue and no retries, with the reason if it failed — for the dashboard's test button.
async function sendNow(text) {
  if (!enabled()) return { ok: false, error: 'توکن یا شناسه‌ی چت ذخیره نشده' };
  const r = await settings.api('sendMessage', { chat_id: chat(), text: lang.tr(String(text)) });
  return r.ok ? { ok: true } : { ok: false, error: r.description || 'خطا از تلگرام' };
}

module.exports = { sendNow, send, enabled, flush, pending: () => queue.length, _setDelays: (d) => { delays = d; } };
