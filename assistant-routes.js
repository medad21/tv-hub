// /api/assistant/* — the in-app analysis assistant (assistant.js). Behind the same dashboard password as everything else.
//   GET  /status                         AI settings + whether Ollama is running and which models it has + live MT5 feed state
//   POST /ollama/setup  { model }        point the AI settings at the local Ollama (the model must already be pulled)
//   GET  /analyze?symbol=&tf=&source=&horizon=&ai=0|1[&context=1]   per-strategy analysis (works with no AI; the AI only rewords)
//   POST /ask  { question, symbol?, tf?, source? }                    a free question about the app / the current analysis
//   GET  /calibration?symbol=&tf=&source=archive|mt5&horizon=         does the probability method hold up on the archive?
// source: auto (live MT5 file if there is one, else the candle archive) | live | archive | mt5 (the MetaTrader archive)
const express = require('express');
const ai = require('./ai');
const A = require('./assistant');
const live = require('./mt5-live');

const STATUS = { NEEDS_KEY: 412, RATE_LIMIT: 429, BAD_SETTINGS: 400, BAD_INPUT: 400, CANNOT: 422, BAD_RESPONSE: 422, TIMEOUT: 504, NO_DATA: 404, BAD_DATA: 422 };
function send(res, e) {
  if (e instanceof A.AssistantError || e instanceof ai.AIError) return res.status(STATUS[e.code] || e.status || 400).json({ error: e.message, code: e.code, needsSetup: e.code === 'NEEDS_KEY' });
  console.error('assistant route:', e && e.stack || e);
  return res.status(500).json({ error: 'خطای داخلی' });
}
const flag = (v) => v === '1' || v === 'true' || v === true;

module.exports = function assistantRouter() {
  const r = express.Router();
  r.use(express.json({ limit: '20kb' }));

  r.get('/status', async (req, res) => {
    try {
      const [ollama] = await Promise.all([A.ollamaStatus()]);
      const lv = live.status();
      res.json({ ai: ai.view(), ollama, live: { exists: lv.exists, files: lv.files.map((f) => ({ symbol: f.mt5Symbol || f.file, tvSymbol: f.tvSymbol || null, fresh: !!f.fresh, ageSec: f.ageSec ?? null })), hint: lv.hint }, disclaimer: A.DISCLAIMER });
    } catch (e) { send(res, e); }
  });

  r.post('/ollama/setup', async (req, res) => { try { res.json({ ok: true, ai: await A.ollamaSetup(req.body || {}) }); } catch (e) { send(res, e); } });

  r.get('/analyze', async (req, res) => {
    try {
      const q = req.query;
      const strategies = typeof q.strategies === 'string' && q.strategies ? q.strategies.split(',').map((s) => s.trim()).filter(Boolean) : null;
      res.json(await A.analyze({ symbol: q.symbol, tf: q.tf, source: q.source || 'auto', horizon: q.horizon, ai: q.ai === undefined ? undefined : flag(q.ai), strategies, includeFacts: flag(q.context), fresh: flag(q.fresh) }));
    } catch (e) { send(res, e); }
  });

  r.post('/ask', async (req, res) => {
    try { const b = req.body || {}; res.json(await A.ask({ question: b.question, symbol: b.symbol, tf: b.tf, source: b.source || 'auto' })); } catch (e) { send(res, e); }
  });

  r.get('/calibration', async (req, res) => {
    try { const q = req.query; res.json(await A.calibration({ symbol: q.symbol, tf: q.tf || '60', source: q.source || 'archive', horizon: q.horizon, force: flag(q.force) })); } catch (e) { send(res, e); }
  });
  return r;
};
