// Decides what to do about a silent market-data feed (kept pure so it can be tested without waiting minutes).
//   silent > restartAfter  -> 'restart'   (the caller exits; Docker/pm2 brings the app back and state.json restores positions)
//   silent > warnAfter     -> 'warn'      (once)
//   was warned and the feed is back -> 'recovered' (once)
function feedAction({ now, lastUpdate, warned }, { warnAfterMs = 180000, restartAfterMs = 300000, recoverUnderMs = 60000 } = {}) {
  const silent = now - lastUpdate;
  if (silent > restartAfterMs) return 'restart';
  if (silent > warnAfterMs && !warned) return 'warn';
  if (warned && silent < recoverUnderMs) return 'recovered';
  return null;
}
module.exports = { feedAction };
