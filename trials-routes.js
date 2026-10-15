// /api/trials — read the research ledger of a symbol, or start a fresh research period for it (after a deliberate decision;
// wiping it makes the "how many ideas did you try" correction forget your past work, so the page asks for confirmation).
const express = require('express');
const T = require('./trials');

module.exports = function trialsRouter() {
  const r = express.Router();
  const sym = (req) => decodeURIComponent(String(req.params.symbol || '')).slice(0, 60);
  r.get('/:symbol', (req, res) => res.json(T.summary(sym(req))));
  r.delete('/:symbol', (req, res) => res.json({ ok: true, wiped: T.reset(sym(req)), ...T.summary(sym(req)) }));
  return r;
};
