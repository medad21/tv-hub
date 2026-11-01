#!/bin/sh
# Same as import-crypto.bat for Linux/macOS/Docker: 8 big pairs, 1-hour candles from 2021-01. Extra options go after it, e.g. --proxy http://127.0.0.1:10809
cd "$(dirname "$0")"
exec node history-import.js --symbols BINANCE:BTCUSDT,BINANCE:ETHUSDT,BINANCE:SOLUSDT,BINANCE:BNBUSDT,BINANCE:XRPUSDT,BINANCE:ADAUSDT,BINANCE:DOGEUSDT,BINANCE:LINKUSDT --tf 60 --from 2021-01 "$@"
