// The "دستیار" (Assistant) tab: per-strategy analysis, a free question box, and the one-tap setup of a local AI (Ollama).
// Standalone on purpose (wrapped in a function, no dependency on the big page script): if that one stops early, this tab still works.
// Mobile-first: big inputs and buttons, cards instead of tables, nothing is edited inside a table.
(function () {
  'use strict';
  var g = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: fine */ } } };

  var css = document.createElement('style');
  css.textContent = [
    '#asView{padding:10px}', '#asView .panel{margin-bottom:12px}', '#asView h2{margin:0;padding:12px 14px;font-size:15px}',
    '.as-pad{padding:0 14px 14px}', '.as-form{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:0 14px 8px}',
    '.as-form .field{min-width:140px}', '.as-form input,.as-form select,.as-ask textarea{font-size:16px;min-height:44px}',
    '.as-ask textarea{width:100%;box-sizing:border-box;font:inherit;font-size:16px;background:#0f1520;border:1px solid var(--line);color:var(--text);border-radius:6px;padding:10px}',
    '.as-big{padding:12px 20px!important;font-size:15px!important;min-height:44px}', '.as-check{display:flex;gap:8px;align-items:center;font-size:13px;color:var(--muted);min-height:44px}',
    '.as-note{padding:0 14px 10px;line-height:1.9;font-size:13px}', '.as-head{font-size:17px;font-weight:600;margin:6px 0}',
    '.as-warn{border:1px solid var(--amber);border-radius:6px;padding:8px 12px;margin:8px 0;color:var(--amber);font-size:13px;line-height:1.9}',
    '.as-list{margin:6px 0;padding-inline-start:20px;line-height:1.95;font-size:13px}',
    '.as-card{border:1px solid var(--line);border-radius:8px;margin:8px 0;background:#0f1520}', '.as-card>summary{cursor:pointer;padding:12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px}',
    '.as-body{padding:0 12px 12px;font-size:13px;line-height:1.95}', '.as-body h4{margin:10px 0 2px;font-size:12px;color:var(--muted);font-weight:500}',
    '.as-tag{font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}',
    '.as-tag.ready{border-color:var(--up);color:var(--up)}', '.as-tag.blocked{border-color:var(--amber);color:var(--amber)}', '.as-tag.exit{border-color:var(--down);color:var(--down)}',
    '.as-plan{background:rgba(63,193,165,.06);border-radius:6px;padding:8px 10px;margin-top:8px}', '.as-caution{color:var(--amber)}',
    '.as-code{direction:ltr;text-align:left;background:#0b1018;border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:6px 0}',
    '.as-models{display:flex;flex-direction:column;gap:8px;margin:8px 0}', '.as-models .runbtn{text-align:start;min-height:48px}',
    '.as-ai{font-size:12px;color:var(--muted);margin-top:10px;line-height:1.9}', '.as-ans{background:#0f1520;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-top:10px;line-height:2;font-size:14px;white-space:pre-wrap}',
  ].join('\n');
  document.head.appendChild(css);

  function api(url, body) {
    var init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(url, init).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, d: d }; }); });
  }
  function say(el, text, bad) { el.innerHTML = text ? '<div class="' + (bad ? 'down' : 'up') + '" style="padding:6px 14px;font-size:13px;line-height:1.9">' + esc(text) + '</div>' : ''; }
  function list(items, cls) { return items && items.length ? '<ul class="as-list' + (cls ? ' ' + cls : '') + '">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : ''; }

  // ---------------------------------------------------------------- analysis
  var DEC_CLASS = { entry_ready: 'ready', entry_blocked: 'blocked', exit: 'exit', exit_signal: 'exit', wait: '', no_data: 'blocked', error: 'exit' };
  function renderReport(r) {
    var h = '<div class="as-head">' + esc(r.headline) + '</div>';
    h += '<div class="muted" dir="ltr" style="text-align:start;font-size:12px">' + esc(r.symbol) + ' · ' + esc(r.timeframeFa) + ' · ' + esc(r.price) + ' · ' + esc(r.source) + '</div>';
    if (r.warnings && r.warnings.length) h += '<div class="as-warn">' + r.warnings.map(esc).join('<br>') + '</div>';
    if (r.position) h += '<div class="as-warn">یک پوزیشن خرید باز است (' + esc(r.position.volume) + ' لات، ورود ' + esc(r.position.open) + ')</div>';
    h += '<div>' + esc(r.overall.summary) + (r.overall.summarySource === 'ai' ? ' <span class="as-tag">بازنویسی با AI</span>' : '') + '</div>';
    h += list(r.overall.lines);
    r.strategies.forEach(function (s) {
      var open = s.decision === 'entry_ready' || s.decision === 'entry_blocked' || s.decision === 'exit';
      h += '<details class="as-card"' + (open ? ' open' : '') + '><summary><b>' + esc(s.name) + '</b><span class="as-tag ' + (DEC_CLASS[s.decision] || '') + '">' + esc(s.decisionFa) + '</span>' + (s.gradeFa ? '<span class="as-tag">' + esc(s.gradeFa) + '</span>' : '') + '</summary><div class="as-body">';
      h += '<div>' + esc(s.summary) + (s.summarySource === 'ai' ? ' <span class="as-tag">بازنویسی با AI</span>' : '') + '</div>';
      if (s.whatItSees && s.whatItSees.length) h += '<h4>چه می‌بیند</h4>' + list(s.whatItSees);
      if (s.why && s.why.length) h += '<h4>چرا</h4>' + list(s.why);
      if (s.plan) {
        h += '<div class="as-plan"><b>' + esc(s.plan.note) + '</b>' + list([s.plan.entry, s.plan.stop, s.plan.target, s.plan.risk].filter(Boolean));
        if (s.plan.odds) h += '<div>' + esc(s.plan.odds) + '</div>';
        if (s.plan.oddsReliability) h += '<div class="muted">' + esc(s.plan.oddsReliability) + '</div>';
        h += '</div>';
      }
      if (s.cautions && s.cautions.length) h += '<h4>هشدارها</h4>' + list(s.cautions, 'as-caution');
      h += '</div></details>';
    });
    var a = r.ai || {};
    h += '<div class="as-ai">' + (a.used ? 'متن را «' + esc(a.model) + '» بازنویسی کرد (' + esc(Math.round(a.ms / 1000)) + ' ثانیه)' + (a.rejected && a.rejected.length ? '؛ ' + a.rejected.length + ' متن او به‌خاطر عدد ناموجود در تحلیل رد و با متن برنامه جایگزین شد' : '؛ همه‌ی عددهایش با تحلیل جور بود')
      : esc(a.error ? 'بازنویسی با AI انجام نشد: ' + a.error : a.reason || '')) + '<br>' + esc(r.disclaimer) + '</div>';
    return h;
  }

  function params() {
    return { symbol: g('asSymbol').value.trim(), tf: g('asTf').value, source: g('asSource').value };
  }
  function analyze() {
    var p = params(), out = g('asOut'), btn = g('asGo');
    if (!p.symbol) { say(g('asMsg'), 'نماد را بنویس (مثلاً OANDA:XAUUSD)', true); return; }
    store.set('as.symbol', p.symbol); store.set('as.tf', p.tf); store.set('as.source', p.source);
    btn.disabled = true; out.innerHTML = '';
    say(g('asMsg'), g('asAi').checked ? 'در حال تحلیل… (اگر مدل محلی روی CPU کند باشد تا چند دقیقه طول می‌کشد)' : 'در حال تحلیل…');
    api('/api/assistant/analyze?symbol=' + encodeURIComponent(p.symbol) + '&tf=' + encodeURIComponent(p.tf) + '&source=' + encodeURIComponent(p.source) + '&ai=' + (g('asAi').checked ? '1' : '0')).then(function (x) {
      btn.disabled = false;
      if (!x.ok) { say(g('asMsg'), x.d.error || 'خطا', true); return; }
      say(g('asMsg'), ''); out.innerHTML = renderReport(x.d.report);
    }).catch(function () { btn.disabled = false; say(g('asMsg'), 'اتصال به سرور برقرار نشد', true); });
  }
  var VERDICT_FA = { reliable: '✅ احتمال‌ها روی تاریخچه جور بودند', unreliable: '⚠️ احتمال‌ها روی این بازار قابل‌اتکا نیستند', insufficient: '⏳ تاریخچه برای قضاوت کافی نیست' };
  function calibrate() {
    var p = params(); if (!p.symbol) { say(g('asMsg'), 'نماد را بنویس', true); return; }
    var btn = g('asCal'); btn.disabled = true; say(g('asMsg'), 'در حال آزمودن احتمال‌ها روی آرشیو کندل…');
    api('/api/assistant/calibration?symbol=' + encodeURIComponent(p.symbol) + '&tf=' + encodeURIComponent(p.tf) + '&source=' + (p.source === 'mt5' ? 'mt5' : 'archive')).then(function (x) {
      btn.disabled = false;
      if (!x.ok) { say(g('asMsg'), x.d.error || 'خطا', true); return; }
      say(g('asMsg'), '');
      g('asOut').innerHTML = '<div class="as-head">' + esc(VERDICT_FA[x.d.verdict] || x.d.verdict) + '</div>' + '<div class="muted">' + esc(x.d.origins) + ' نقطه‌ی آزمون، افق ' + esc(x.d.horizon) + ' کندل' + (x.d.cached ? ' (نتیجه‌ی ذخیره‌شده)' : '') + '</div>' + list(x.d.reasons) + '<div class="muted">این آزمون فقط می‌گوید «۴۰٪» واقعاً حدود ۴۰٪ اتفاق افتاده یا نه؛ جهت بازار را پیش‌بینی نمی‌کند. بعد از آن، دوباره «تحلیل کن» را بزن.</div>';
    }).catch(function () { btn.disabled = false; say(g('asMsg'), 'اتصال به سرور برقرار نشد', true); });
  }

  // ---------------------------------------------------------------- question
  function ask() {
    var q = g('asQ').value.trim(), out = g('asAns');
    if (!q) { out.innerHTML = ''; return; }
    var p = params(), body = { question: q };
    if (p.symbol && g('asQWith').checked) { body.symbol = p.symbol; body.tf = p.tf; body.source = p.source; }
    g('asAsk').disabled = true; out.innerHTML = '<div class="muted">در حال پاسخ…</div>';
    api('/api/assistant/ask', body).then(function (x) {
      g('asAsk').disabled = false;
      if (!x.ok) { out.innerHTML = '<div class="as-warn">' + esc(x.d.error || 'خطا') + (x.d.needsSetup ? '<br>اول هوش مصنوعی را راه‌اندازی کن (پایین‌ترین بخش همین صفحه).' : '') + '</div>'; return; }
      out.innerHTML = '<div class="as-ans">' + esc(x.d.answer) + '</div>' + (x.d.warning ? '<div class="as-warn">' + esc(x.d.warning) + '</div>' : '');
    }).catch(function () { g('asAsk').disabled = false; out.innerHTML = '<div class="as-warn">اتصال به سرور برقرار نشد</div>'; });
  }

  // ---------------------------------------------------------------- Ollama
  function copyBtn(text) { return '<button type="button" class="runbtn secondary" data-copy="' + esc(text) + '" style="padding:4px 12px;font-size:12px">کپی</button>'; }
  function renderOllama(s) {
    var o = s.ollama, v = s.ai, h = '';
    h += '<div style="line-height:2;font-size:14px">' + (o.reachable ? '✅ Ollama روی این سیستم روشن است' : '❌ Ollama پیدا نشد') + '<br>' +
      (v.configured ? 'هوش مصنوعی فعال: <b dir="ltr">' + esc(v.provider === 'anthropic' ? 'Claude' : (o.usingOllama ? 'Ollama' : 'OpenAI-compatible')) + ' / ' + esc(v.model) + '</b>' : '<span class="muted">هوش مصنوعی هنوز تنظیم نشده (تحلیل بدون آن هم کامل کار می‌کند)</span>') + '</div>';
    if (!o.reachable) {
      var i = o.install;
      h += '<div class="as-warn">' + esc(o.error || '') + '</div>';
      h += '<h4 style="margin:10px 0 4px;font-size:13px">نصب (یک‌بار)</h4>';
      h += '<div class="muted" style="line-height:1.9;font-size:13px">سیستم برنامه: ' + esc(i.system) + ' · حافظه حدود ' + esc(i.ramGB) + ' گیگابایت<br>مدل پیشنهادی: <b dir="ltr">' + esc(i.recommended.model) + '</b> — ' + esc(i.recommended.why) + '</div>';
      h += '<div style="margin:10px 0"><a class="runbtn as-big" href="' + esc(i.downloadPage) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block;text-decoration:none">دانلود Ollama از سایت رسمی</a></div>';
      h += '<div class="muted" style="font-size:13px">یا نصب خودکار: فایل <b dir="ltr">' + esc(i.script) + '</b> (کنار برنامه) را یک بار اجرا کن؛ خودش Ollama را نصب و مدل مناسب سیستم را دانلود می‌کند. یا این دستور:</div>';
      h += '<div class="as-code">' + esc(i.command) + '</div>' + copyBtn(i.command) + '<div class="as-code">' + esc(i.pull) + '</div>' + copyBtn(i.pull);
      h += '<details style="margin-top:10px"><summary class="muted" style="cursor:pointer">دستور سیستم‌عامل‌های دیگر</summary><div class="as-code">Windows:  ' + esc(i.commands.windows) + '\nmacOS:    ' + esc(i.commands.macos) + '\nLinux:    ' + esc(i.commands.linux) + '</div></details>';
      h += '<div class="muted" style="margin-top:8px;font-size:12px;line-height:1.9">' + esc(i.why) + '<br>' + esc(i.note) + '</div>';
      h += '<div class="muted" style="margin-top:8px;font-size:13px">بعد از نصب و دانلود مدل، دکمه‌ی «بررسی دوباره» را بزن؛ مدل‌ها همین‌جا ظاهر می‌شوند و با یک ضربه وصل می‌شوند.</div>';
    } else if (!o.models.length) {
      h += '<div class="as-warn">Ollama روشن است ولی هنوز مدلی ندارد. این دستور را در ترمینال بزن و بعد «بررسی دوباره»:</div><div class="as-code">' + esc(o.install.pull) + '</div>' + copyBtn(o.install.pull) + '<div class="muted" style="font-size:12px;margin-top:6px">' + esc(o.install.recommended.why) + '</div>';
    } else {
      h += '<h4 style="margin:10px 0 4px;font-size:13px">مدل‌های نصب‌شده — یکی را انتخاب کن تا برنامه به آن وصل شود</h4><div class="as-models">';
      o.models.forEach(function (m) {
        var active = o.usingOllama && o.activeModel === m.name;
        h += '<button type="button" class="runbtn' + (active ? '' : ' secondary') + '" data-model="' + esc(m.name) + '"><span dir="ltr">' + esc(m.name) + '</span>' + (m.sizeMB ? ' · ' + esc(Math.round(m.sizeMB / 100) / 10) + ' گیگابایت' : '') + (active ? ' ✔ فعال' : '') + '</button>';
      });
      h += '</div><div class="muted" style="font-size:12px;line-height:1.9">پیشنهاد برای این سیستم: <span dir="ltr">' + esc(o.install.recommended.model) + '</span> — ' + esc(o.install.recommended.why) + '. مدل بزرگ‌تر بهتر می‌نویسد ولی کندتر است.</div>';
    }
    h += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button id="asOllRe" class="runbtn secondary as-big" type="button">بررسی دوباره</button>' + (v.configured ? '<button id="asPing" class="runbtn secondary as-big" type="button">آزمایش اتصال</button>' : '') + '</div><div id="asOllMsg"></div>';
    h += '<div class="muted" style="margin-top:10px;font-size:12px;line-height:1.9">' + esc(o.note) + '</div>';
    g('asOllama').innerHTML = h;
    if (s.live) {
      var dl = g('asSymbols'), have = {}; dl.innerHTML = '';
      (s.live.files || []).map(function (f) { return [f.tvSymbol, f.symbol]; }).concat([['OANDA:XAUUSD'], ['BINANCE:BTCUSDT']]).forEach(function (a) { a.forEach(function (x) { if (x && !have[x]) { have[x] = 1; dl.insertAdjacentHTML('beforeend', '<option value="' + esc(x) + '">'); } }); });
    }
  }
  function loadStatus() {
    g('asOllama').innerHTML = '<div class="muted">در حال بررسی…</div>';
    return api('/api/assistant/status').then(function (x) { if (!x.ok) { g('asOllama').innerHTML = '<div class="as-warn">' + esc(x.d.error || 'خطا') + '</div>'; return; } renderOllama(x.d); }).catch(function () { g('asOllama').innerHTML = '<div class="as-warn">اتصال به سرور برقرار نشد</div>'; });
  }
  g('asOllama').addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.id === 'asOllRe') return void loadStatus();
    if (t.dataset.copy) { try { navigator.clipboard.writeText(t.dataset.copy); t.textContent = 'کپی شد'; } catch (er) { t.textContent = 'کپی نشد؛ متن را دستی انتخاب کن'; } return; }
    if (t.dataset.model) {
      say(g('asOllMsg'), 'در حال اتصال…');
      api('/api/assistant/ollama/setup', { model: t.dataset.model }).then(function (x) {
        if (!x.ok) { say(g('asOllMsg'), x.d.error || 'خطا', true); return; }
        say(g('asOllMsg'), 'وصل شد؛ در حال آزمایش (برای اولین بار ممکن است مدل چند دقیقه طول بکشد تا بالا بیاید)…');
        return api('/api/ai/ping', {}).then(function (p) { loadStatus().then(function () { say(g('asOllMsg'), p.ok ? '✅ مدل جواب داد؛ حالا «تحلیل کن» را با تیک بازنویسی بزن' : (p.d.error || 'آزمایش ناموفق بود'), !p.ok); }); });
      });
      return;
    }
    if (t.id === 'asPing') { say(g('asOllMsg'), 'در حال آزمایش…'); api('/api/ai/ping', {}).then(function (p) { say(g('asOllMsg'), p.ok ? '✅ مدل جواب داد' : (p.d.error || 'آزمایش ناموفق بود'), !p.ok); }); }
  });

  // ---------------------------------------------------------------- wiring
  g('asGo').addEventListener('click', analyze);
  g('asCal').addEventListener('click', calibrate);
  g('asAsk').addEventListener('click', ask);
  g('asSymbol').value = store.get('as.symbol') || 'OANDA:XAUUSD';
  g('asTf').value = store.get('as.tf') || '60';
  g('asSource').value = store.get('as.source') || 'auto';
  var nav = document.querySelector('[data-view="asView"]');
  if (nav) nav.addEventListener('click', loadStatus);
})();
