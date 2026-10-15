// Dashboard API for custom strategies (mounted at /api/custom by server.js; kept separate so it can be tested without the
// TradingView connection). Same access control as the rest of /api (the auth middleware runs before this router).
const express = require('express');
const custom = require('./custom-strategies');
const { STRATEGIES, customErrors } = require('./strategy');

module.exports = function customRouter(cfg) {
  const r = express.Router();
  r.use(express.json());
  const view = (status) => ({
    ...status,
    activeStrategy: cfg.strategy.id,
    activeMissing: !STRATEGIES[cfg.strategy.id],
    runtimeErrors: Object.fromEntries(Object.keys(STRATEGIES).filter((id) => STRATEGIES[id].custom && customErrors(id)).map((id) => [id, customErrors(id)])),
    parts: Object.entries(STRATEGIES).filter(([, s]) => !s.components).map(([id, s]) => ({ id, name: s.name, custom: !!s.custom })),
  });

  r.get('/', (req, res) => res.json(view(custom.getStatus())));

  r.post('/reload', (req, res) => res.json(view(custom.load())));

  r.post('/combos', (req, res) => {
    try { const out = custom.addCombo(req.body || {}); res.json({ ok: true, id: out.id, ...view(out.status) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.post('/rules', (req, res) => {
    try { const out = custom.addRules(req.body || {}); res.json({ ok: true, id: out.id, ...view(out.status) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.delete('/rules/:id', (req, res) => {
    const id = req.params.id;
    if (id === cfg.strategy.id) return res.status(409).json({ error: 'این استراتژی الان استراتژی فعال ربات است؛ اول استراتژی ربات را عوض کن' });
    const users = custom.combosUsing(id);
    if (users.length) return res.status(409).json({ error: `این استراتژی جزء ترکیب‌های «${users.join('، ')}» است؛ اول آن‌ها را پاک کن` });
    try {
      const status = custom.removeRules(id);
      if (!status) return res.status(404).json({ error: 'استراتژی پیدا نشد' });
      res.json({ ok: true, ...view(status) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.delete('/combos/:id', (req, res) => {
    const id = req.params.id;
    if (id === cfg.strategy.id) return res.status(409).json({ error: 'این ترکیب الان استراتژی فعال ربات است؛ اول استراتژی ربات را عوض کن' });
    try {
      const status = custom.removeCombo(id);
      if (!status) return res.status(404).json({ error: 'ترکیب پیدا نشد' });
      res.json({ ok: true, ...view(status) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  return r;
};
