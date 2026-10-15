# TV Hub

**English** · [فارسی](README.fa.md) · [Deutsch](README.de.md)

A live [TradingView](https://www.tradingview.com) dashboard plus a trading bot with three modes: **signal** (alerts only), **paper** (virtual trading) and **live** (real orders). It comes with full risk management, a backtesting engine, statistical validation that tries hard not to fool you, Telegram control, and optional AI-assisted strategy building.

> ⚠️ **Disclaimer:** This project is for education and research. It is **not financial advice** and no strategy in it is guaranteed to be profitable. Trading can lose you money. The real-order code paths were only tested against mocked exchanges and brokers, so always start on a testnet or demo account.

> ℹ️ The dashboard interface is currently in **Persian (RTL)**. The bot, the Telegram messages and the configuration work the same regardless of your language.

---

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Docker and 24/7 hosting](#docker-and-247-hosting)
- [Configuration](#configuration)
- [Modes](#modes)
- [Strategies](#strategies)
- [Risk management](#risk-management)
- [Backtesting and validation](#backtesting-and-validation)
- [Supported markets and brokers](#supported-markets-and-brokers)
- [Telegram](#telegram)
- [Before you trade real money](#before-you-trade-real-money)
- [Project layout](#project-layout)
- [Tests](#tests)
- [Known limitations](#known-limitations)
- [Credits](#credits)

## Features

- **Live dashboard** with TradingView data, signals, open positions and a reporting tab (P&L, win rate, profit factor, drawdown, per-symbol breakdown, CSV export).
- **Three modes:** `signal`, `paper`, `live`.
- **Built-in strategies** (RSI mean reversion, trend following, breakout, momentum reversal), three combined voting setups, a no-code combo builder, and your own JavaScript strategies.
- **Optional AI helper:** describe an idea in plain words and get a strategy that you then backtest. The AI never writes code; it only fills a validated rule structure.
- **Risk management:** ATR-based stops, risk/reward targets, trailing stop, risk-based position sizing, per-group exposure caps, daily loss limit, max drawdown halt, cooldowns and a trend filter.
- **Backtesting** from the dashboard or the command line, with next-candle-open fills and per-market trading costs.
- **Honest statistics:** walk-forward, Monte Carlo, block bootstrap, a multiple-testing correction, an untouched hold-out period and a research ledger that counts how many ideas you tried.
- **Forward evidence:** compares the bot's real results with a backtest over the same weeks.
- **Long history import** from the public Binance archive for much better statistics.
- **Telegram** alerts and remote control (`/status`, `/positions`, `/pnl`, `/close`, `/halt`, `/resume`, `/panic`).
- **Mobile friendly:** installable to your home screen (PWA), password protected.
- **Safety nets:** atomic state files, corruption detection, exchange-side stops, startup reconciliation and a watchdog.

## Quick start

Requirements: **Node.js 18 or newer** (Node 20/22 recommended).

```bash
git clone <your-repo-url> tv-hub
cd tv-hub
```

- **Windows:** double-click `start.bat`
- **macOS / Linux:** `./start.sh`

On the first run the script installs the dependencies and creates a `.env` file from `.env.example`. Then open **http://localhost:3000**.

Or manually:

```bash
npm install
cp .env.example .env
npm start
```

The default mode is `MODE=signal`, which never opens positions.

## Docker and 24/7 hosting

```bash
cp .env.example .env     # set MODE and a strong DASH_PASSWORD
docker compose up -d
```

- Restarts automatically after a crash or a reboot (`restart: unless-stopped`).
- If market data is silent for 5 minutes the app exits so Docker can restart it.
- `state.json` and the event log live in a Docker volume and survive restarts.

**Do not expose port 3000 to the internet without HTTPS.** Safe options are [Tailscale](https://tailscale.com) (private network) or a Cloudflare Tunnel (strong password required). To reach the dashboard from your phone, set `HOST=0.0.0.0` and a strong `DASH_PASSWORD` (the app refuses to start without one in that case).

## Configuration

Everything is in `.env` (see `.env.example` for all options):

```env
MODE=signal                     # signal | paper | live
SYMBOLS=BINANCE:BTCUSDT,OANDA:XAUUSD   # EXCHANGE:TICKER, empty = built-in list of 25
TIMEFRAME=60                    # 1, 5, 15, 30, 60, 240, D, W (default 15)
HOST=127.0.0.1
DASH_PASSWORD=
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
LIVE_CONFIRM=NO                 # must be YES to place real orders
```

Strategy, risk and filter defaults live in `config.js`. Settings you apply from the dashboard are saved to `config.local.json`. Every symbol that TradingView offers in `EXCHANGE:TICKER` form can be watched.

## Modes

| Mode | What it does |
|---|---|
| `signal` | Alerts only (dashboard and Telegram). Each message includes the strategy, suggested entry, stop, target and the reasoning. The bot is long-only, so a sell signal means "close", not "go short". |
| `paper` | Virtual trading with 10,000 units of capital, including fees and slippage. |
| `live` | Real orders on crypto exchanges, US stocks (Alpaca) and forex/gold (OANDA). Requires keys and `LIVE_CONFIRM=YES`. A symbol whose broker has no keys stays signal-only. |

## Strategies

| Strategy | Idea |
|---|---|
| Temporary pullback (RSI) — default | Buy sharp oversold dips, sell when overbought. |
| Trend following | Buy when the short-term average crosses above the long-term one. |
| Breakout | Buy a new 20-candle high, exit on a new 20-candle low. |
| Momentum reversal (MACD) | Buy when momentum turns up, sell when it turns down. |
| Combined setups | Pullback in an uptrend, breakout with momentum confirmation, and a four-strategy consensus. |

On top of that you can build **combos** without coding (pick strategies and a vote threshold), write your own strategies in **JavaScript** (copy `custom-strategies.example.js` to `custom-strategies.user.js`), or use the **AI helper** with your own API key (Claude or any OpenAI-compatible service, including a local Ollama; the key is stored on the server only and never sent back to the browser). Without a key you can paste a generated prompt into any chatbot and import the answer.

> Custom JavaScript strategies run in the same process without a sandbox. Only run code you wrote or fully understand.

## Risk management

ATR-based stop loss (default 2×ATR), 1:2 risk/reward target, trailing stop after 1R, position size from a fixed risk per trade (default 1% of capital), single-position cap, per-market-group exposure cap (crypto / stocks / forex), automatic risk reduction on very volatile symbols, max concurrent positions, daily loss limit, max drawdown halt, cooldown after each close, an EMA100 trend filter, a multi-indicator confirmation filter, and optional partial exits (crypto in live mode only).

## Backtesting and validation

```bash
npm run backtest          # run the current strategy on historical candles
npm run sweep             # try 270 parameter combinations (train/test ranked)
npm run import-history -- --symbols BINANCE:BTCUSDT --tf 15,60 --from 2023-01
```

The backtester shares its engine with the live bot, so results reflect real behavior. It fills at the **next candle open** and applies separate costs for crypto, stocks and forex. Results can be weaker than naive backtests; that is intended.

A result is only labelled **reliable** when it passes all of these: at least 30 trades, profit factor ≥ 1.2, positive average R, profitable in at least 3 of 5 walk-forward windows, a low Monte Carlo loss probability, a block-bootstrap significance test adjusted for the number of ideas you tried, and a one-time check on 25% of the data that was kept out of every decision. If nothing passes, the report says so instead of picking the "best of the bad".

## Supported markets and brokers

| Market | Provider | Keys |
|---|---|---|
| Crypto spot | Binance, Bybit, OKX, KuCoin, Kraken, Coinbase, Bitget, Gate.io, MEXC (via ccxt) | `*_KEY`, `*_SECRET` (+ `*_PASSPHRASE` for OKX, KuCoin, Bitget) |
| US stocks | Alpaca (paper by default) | `ALPACA_KEY`, `ALPACA_SECRET` |
| Forex and gold | OANDA (practice by default) | `OANDA_TOKEN`, `OANDA_ACCOUNT_ID` |

Use API keys with **trade permission only, never withdrawal**. Whether a service is available to you depends on your country's laws and the service's terms.

## Telegram

Create a bot with `@BotFather`, then connect it from the dashboard panel or via `.env`. You get signal alerts, startup and outage notices, a daily summary and a weekly evidence report, and you can control the bot from the registered chat only: `/status`, `/positions`, `/pnl`, `/close BTCUSDT`, `/halt`, `/resume`, `/panic`. An optional HTTP proxy is supported for Telegram only.

## Before you trade real money

1. `npm test`
2. `npm run backtest` and `npm run sweep` on real data
3. `MODE=paper` for several weeks
4. `MODE=live` on a testnet or demo account (`EXCHANGE_TESTNET=YES`, `ALPACA_PAPER=YES`, `OANDA_PRACTICE=YES`)
5. Only then: real keys, a very small `capitalUsdt`, and `LIVE_CONFIRM=YES`

## Project layout

| File | Purpose |
|---|---|
| `server.js` | HTTP server, dashboard and API |
| `bot.js` | Trading bot and risk handling |
| `strategy.js`, `rules.js`, `custom-strategies*.js` | Indicators, strategies and custom rules |
| `risk.js`, `config.js`, `config-overrides.js` | Sizing, limits and settings |
| `backtest*.js`, `significance.js`, `trials.js`, `evidence.js` | Backtesting and statistical validation |
| `history-import.js`, `candle-store.js` | Long history import and candle archive |
| `broker-alpaca.js`, `broker-oanda.js` | Stock and forex brokers |
| `telegram*.js`, `notify.js`, `summary.js` | Telegram and notifications |
| `ai*.js` | Optional AI strategy helper |
| `public/` | Dashboard front end |

## Tests

```bash
npm test
```

The suite runs offline against mocked exchanges and brokers and covers risk logic, brokers, backtesting, statistics, alerts, reliability, custom strategies, the AI helper, live-trading safety and more.

## Known limitations

- Market data comes from an unofficial TradingView library that may break when TradingView changes.
- Stop loss and take profit are monitored by the app; exchange-side stops are on by default for crypto, but a trailing stop only moves inside the app (for Alpaca and OANDA the broker-side stop stays fixed).
- Gaps can cause losses larger than the stop.
- Long history import works for Binance spot only; stocks and forex are limited to what TradingView provides plus the growing local archive.
- The dashboard UI is Persian only for now.

## Credits

Created by **Ehsan Bagheryane** ([@medad21](https://github.com/medad21)).

Built on [@mathieuc/tradingview](https://github.com/Mathieu2301/TradingView-API), [ccxt](https://github.com/ccxt/ccxt), [Express](https://expressjs.com) and [ws](https://github.com/websockets/ws).
