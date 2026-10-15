// /api/ai/* — settings (key slot), connection test, and "plain words -> strategy proposal". Behind the same dashboard
// password as everything else. The key is accepted here but NEVER returned: GET shows only "a key is saved (…abcd)".
const express = require('express');
const ai = require('./ai');
const { proposeStrategy, parseReply, manualPrompt } = require('./ai-strategy');

const STATUS = { NEEDS_KEY: 412, RATE_LIMIT: 429, BAD_SETTINGS: 400, BAD_INPUT: 400, CANNOT: 422, BAD_RESPONSE: 422, TIMEOUT: 504 };
function send(res, e) {
  if (e instanceof ai.AIError) return res.status(STATUS[e.code] || e.status || 502).json({ error: e.message, code: e.code, needsSetup: e.code === 'NEEDS_KEY' });
  console.error('ai route:', e && e.message);
  return res.status(500).json({ error: 'خطای داخلی' });
}

module.exports = function aiRouter() {
  const r = express.Router();
  r.use(express.json());
  r.get('/settings', (req, res) => res.json(ai.view()));
  r.post('/settings', (req, res) => { try { res.json(ai.save(req.body)); } catch (e) { send(res, e); } });
  // a tiny real request, so a wrong key / model / address shows up now and not in the middle of a strategy
  r.post('/ping', async (req, res) => {
    try {
      const text = await ai.complete({ system: 'Reply with the single word OK.', user: 'ping', maxTokens: 20 });
      res.json({ ok: true, reply: text.trim().slice(0, 40) });
    } catch (e) { send(res, e); }
  });
  r.post('/strategy', async (req, res) => {
    try { res.json({ ok: true, proposal: await proposeStrategy(req.body && req.body.text) }); } catch (e) { send(res, e); }
  });
  // no key: the page builds the text to paste into any chatbot, then sends the chatbot's answer back for the same validation
  r.post('/prompt', (req, res) => { try { res.json({ ok: true, prompt: manualPrompt(req.body && req.body.text) }); } catch (e) { send(res, e); } });
  r.post('/parse', (req, res) => {
    try {
      const reply = req.body && typeof req.body.reply === 'string' ? req.body.reply : '';
      if (!reply.trim() || reply.length > 20000) throw new ai.AIError('BAD_INPUT', 'پاسخ چت‌بات را (JSON) در کادر بچسبان', 400);
      try { res.json({ ok: true, proposal: parseReply(reply) }); }
      catch (e) { if (e instanceof ai.AIError) throw e; throw new ai.AIError('BAD_RESPONSE', `این پاسخ قاعده‌ی معتبری نیست: ${e.message}`, 422); }
    } catch (e) { send(res, e); }
  });
  return r;
};
