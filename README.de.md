# TV Hub

[English](README.md) · [فارسی](README.fa.md) · **Deutsch**

Ein Live-Dashboard für [TradingView](https://www.tradingview.com) mit integriertem Trading-Bot in drei Modi: **Signal** (nur Benachrichtigungen), **Paper** (virtueller Handel) und **Live** (echte Orders). Dazu gehören ein vollständiges Risikomanagement, eine Backtesting-Engine, statistische Validierung, die verhindern soll, dass man sich selbst täuscht, Telegram-Steuerung und optional KI-gestützte Strategieentwicklung.

> ⚠️ **Haftungsausschluss:** Dieses Projekt dient der Bildung und Forschung. Es ist **keine Anlageberatung**, und keine der enthaltenen Strategien verspricht Gewinne. Beim Handel kann Geld verloren gehen. Der Code für echte Orders wurde nur gegen simulierte Börsen und Broker getestet. Beginne daher immer mit einem Testnet- oder Demokonto.

> ℹ️ Das Dashboard hat oben einen Sprachschalter (**English / فارسی**). Telegram-Nachrichten, Berichte und Konsolenausgaben folgen `APP_LANG` in der `.env` (`fa` = Persisch, Standard; `en` = Englisch).

---

## Inhaltsverzeichnis

- [Funktionen](#funktionen)
- [Schnellstart](#schnellstart)
- [Docker und Dauerbetrieb](#docker-und-dauerbetrieb)
- [Konfiguration](#konfiguration)
- [Modi](#modi)
- [Strategien](#strategien)
- [Risikomanagement](#risikomanagement)
- [Backtesting und Validierung](#backtesting-und-validierung)
- [Märkte und Broker](#märkte-und-broker)
- [Telegram](#telegram)
- [Bevor du echtes Geld einsetzt](#bevor-du-echtes-geld-einsetzt)
- [Projektstruktur](#projektstruktur)
- [Tests](#tests)
- [Bekannte Einschränkungen](#bekannte-einschränkungen)
- [Mitwirkende](#mitwirkende)

## Funktionen

- **Live-Dashboard** mit TradingView-Daten, Signalen, offenen Positionen und einem Berichts-Tab (Gewinn/Verlust, Gewinnrate, Profit Factor, Drawdown, Aufschlüsselung nach Symbol, CSV-Export).
- **Drei Modi:** `signal`, `paper`, `live`.
- **Eingebaute Strategien** (RSI-Rücksetzer, Trendfolge, Ausbruch, Momentum-Umkehr), drei kombinierte Abstimmungs-Setups, ein Kombi-Baukasten ohne Programmierung und eigene JavaScript-Strategien.
- **Optionaler KI-Helfer:** Beschreibe eine Idee in einfachen Worten und erhalte eine Strategie, die du anschließend per Backtest prüfst. Die KI schreibt keinen Code, sondern füllt nur eine geprüfte Regelstruktur aus.
- **Risikomanagement:** ATR-basierter Stop-Loss, Chance-Risiko-Ziele, Trailing-Stop, risikobasierte Positionsgröße, Limits pro Marktgruppe, Tagesverlustlimit, Stopp bei maximalem Drawdown, Abkühlphasen und Trendfilter.
- **Backtesting** im Dashboard oder auf der Kommandozeile, mit Ausführung zur Eröffnung der nächsten Kerze und getrennten Kosten pro Markt.
- **Ehrliche Statistik:** Walk-Forward, Monte-Carlo, Block-Bootstrap, Korrektur für Mehrfachtests, ein unberührter Hold-out-Zeitraum und ein Forschungsprotokoll, das zählt, wie viele Ideen du ausprobiert hast.
- **Forward-Evidenz:** vergleicht die echten Ergebnisse des Bots mit einem Backtest über dieselben Wochen.
- **Import langer Historien** aus dem öffentlichen Binance-Archiv für deutlich bessere Statistik.
- **Telegram** für Benachrichtigungen und Fernsteuerung (`/status`, `/positions`, `/pnl`, `/close`, `/halt`, `/resume`, `/panic`).
- **Mobilfreundlich:** Installation auf dem Startbildschirm (PWA), passwortgeschützt.
- **Sicherheitsnetze:** atomare Zustandsdateien, Erkennung beschädigter Dateien, börsenseitige Stops, Abgleich beim Start und ein Watchdog.

## Schnellstart

Voraussetzung: **Node.js 18 oder neuer** (Node 20/22 empfohlen).

```bash
git clone https://github.com/medad21/tv-hub.git
cd tv-hub
```

- **Windows:** Doppelklick auf `start.bat`
- **macOS / Linux:** `./start.sh`

Beim ersten Start installiert das Skript die Abhängigkeiten und erstellt aus `.env.example` eine `.env`. Öffne dann **http://localhost:3000**.

Oder manuell:

```bash
npm install
cp .env.example .env
npm start
```

Der Standardmodus ist `MODE=signal`; er eröffnet nie Positionen.

## Docker und Dauerbetrieb

```bash
cp .env.example .env     # MODE und ein starkes DASH_PASSWORD setzen
docker compose up -d
```

- Startet nach einem Absturz oder Neustart automatisch neu (`restart: unless-stopped`).
- Sind die Marktdaten 5 Minuten lang still, beendet sich die App, damit Docker sie neu starten kann.
- `state.json` und das Ereignisprotokoll liegen in einem Docker-Volume und bleiben erhalten.

**Öffne Port 3000 nicht ohne HTTPS im Internet.** Sichere Optionen sind [Tailscale](https://tailscale.com) (privates Netzwerk) oder ein Cloudflare Tunnel (starkes Passwort erforderlich). Für den Zugriff vom Handy setze `HOST=0.0.0.0` und ein starkes `DASH_PASSWORD` (ohne Passwort startet die App in diesem Fall nicht).

## Konfiguration

Alles steht in der `.env` (alle Optionen siehe `.env.example`):

```env
MODE=signal                     # signal | paper | live
SYMBOLS=BINANCE:BTCUSDT,OANDA:XAUUSD   # EXCHANGE:TICKER, leer = eingebaute Liste mit 25 Symbolen
TIMEFRAME=60                    # 1, 5, 15, 30, 60, 240, D, W (Standard 15)
APP_LANG=fa                     # fa | en — Sprache von Telegram-Nachrichten, Berichten und Konsolenausgaben
HOST=127.0.0.1
DASH_PASSWORD=
TELEGRAM_TOKEN=
TELEGRAM_CHAT_ID=
LIVE_CONFIRM=NO                 # muss YES sein, damit echte Orders möglich sind
```

Standardwerte für Strategie, Risiko und Filter stehen in `config.js`. Im Dashboard übernommene Einstellungen werden in `config.local.json` gespeichert. Jedes Symbol, das TradingView im Format `EXCHANGE:TICKER` anbietet, kann beobachtet werden.

## Modi

| Modus | Was er tut |
|---|---|
| `signal` | Nur Benachrichtigungen (Dashboard und Telegram). Jede Nachricht nennt Strategie, vorgeschlagenen Einstieg, Stop, Ziel und die Begründung. Der Bot handelt nur Long; ein Verkaufssignal bedeutet also „schließen“, nicht „short gehen“. |
| `paper` | Virtueller Handel mit 10.000 Einheiten Kapital, inklusive Gebühren und Slippage. |
| `live` | Echte Orders an Krypto-Börsen, US-Aktien (Alpaca) und Forex/Gold (OANDA). Erfordert Schlüssel und `LIVE_CONFIRM=YES`. Ein Symbol, dessen Broker keine Schlüssel hat, bleibt auf Signalbetrieb. |

## Strategien

| Strategie | Idee |
|---|---|
| Vorübergehender Rücksetzer (RSI) — Standard | Kauft starke überverkaufte Einbrüche, verkauft bei Überkauft. |
| Trendfolge | Kauf, wenn der kurzfristige Durchschnitt über den langfristigen steigt. |
| Ausbruch | Kauf bei neuem 20-Kerzen-Hoch, Ausstieg bei neuem 20-Kerzen-Tief. |
| Momentum-Umkehr (MACD) | Kauf, wenn das Momentum nach oben dreht, Verkauf, wenn es nach unten dreht. |
| Kombinierte Setups | Rücksetzer im Aufwärtstrend, Ausbruch mit Momentum-Bestätigung und ein Konsens aus vier Strategien. |

Zusätzlich kannst du ohne Programmierung **Kombis** bauen (Strategien und Stimmenschwelle wählen), eigene Strategien in **JavaScript** schreiben (kopiere `custom-strategies.example.js` nach `custom-strategies.user.js`) oder den **KI-Helfer** mit deinem eigenen API-Schlüssel nutzen (Claude oder jeder OpenAI-kompatible Dienst, auch lokales Ollama; der Schlüssel bleibt nur auf dem Server und wird nie an den Browser zurückgegeben). Ohne Schlüssel kannst du einen vorbereiteten Prompt in einen beliebigen Chatbot einfügen und die Antwort importieren.

> Eigene JavaScript-Strategien laufen im selben Prozess ohne Sandbox. Führe nur Code aus, den du selbst geschrieben hast oder vollständig verstehst.

## Risikomanagement

ATR-basierter Stop-Loss (Standard 2×ATR), Chance-Risiko-Ziel 1:2, Trailing-Stop nach 1R, Positionsgröße aus festem Risiko pro Trade (Standard 1 % des Kapitals), Limit für eine einzelne Position, Limit pro Marktgruppe (Krypto / Aktien / Forex), automatische Risikoreduzierung bei sehr volatilen Symbolen, maximale gleichzeitige Positionen, Tagesverlustlimit, Stopp bei maximalem Drawdown, Abkühlphase nach jedem Schließen, EMA100-Trendfilter, Bestätigungsfilter mit mehreren Indikatoren und optionale Teilausstiege (nur Krypto im Live-Modus).

## Backtesting und Validierung

```bash
npm run backtest          # aktuelle Strategie auf historischen Kerzen ausführen
npm run sweep             # 270 Parameterkombinationen testen (Train/Test-Ranking)
npm run import-history -- --symbols BINANCE:BTCUSDT --tf 15,60 --from 2023-01
```

Der Backtester nutzt dieselbe Engine wie der Live-Bot, die Ergebnisse spiegeln also das echte Verhalten wider. Ausführung zur **Eröffnung der nächsten Kerze**, mit getrennten Kosten für Krypto, Aktien und Forex. Die Ergebnisse können schwächer ausfallen als bei naiven Backtests; das ist gewollt.

Ein Ergebnis gilt nur als **verlässlich**, wenn es alles Folgende besteht: mindestens 30 Trades, Profit Factor ≥ 1,2, positives durchschnittliches R, Gewinn in mindestens 3 von 5 Walk-Forward-Fenstern, geringe Verlustwahrscheinlichkeit in der Monte-Carlo-Simulation, ein Block-Bootstrap-Signifikanztest, korrigiert um die Zahl der ausprobierten Ideen, und eine einmalige Prüfung auf 25 % der Daten, die von jeder Entscheidung ausgeschlossen waren. Besteht nichts, sagt der Bericht das offen, statt das „beste der schlechten“ Ergebnisse auszuwählen.

### Lange Gold-/Forex-Historie aus MetaTrader 5

TradingView liefert nur die letzten paar tausend Kerzen. MetaTrader 5 hält für Gold und Forex Jahre davon auf dem Server deines Brokers, und tv-hub liest sie ohne Python und ohne API-Schlüssel:

1. Kopiere `mt5/TvHubExport.mq5` in den Ordner `MQL5\Scripts` von MT5 (MT5: Datei → Datenordner öffnen), öffne es im MetaEditor (F4), kompiliere (F7) und ziehe es aus Navigator → Skripte auf ein Chart. Wähle im Dialog die Symbole aus einer Liste (dieses Chart / alles im Market Watch / Gold, Silber und die 7 Majors / eigene Liste) und hake die Zeitrahmen an (M1 bis monatlich). Das Skript liest nur die Historie und handelt nie. Extras → Optionen → Charts → „Max. Bars im Chart“ begrenzt, wie viel es exportieren kann (für M1 erhöhen).
2. Starte `import-mt5.bat` (oder `npm run import-mt5`). `--dry` prüft nur, `--dir <Ordner>` für ein portables MT5, `--map "GOLD#=OANDA:XAUUSD"` für unbekannte Namen, `--offset ny:7`, um die Broker-Uhr selbst anzugeben.
3. Im Backtest-Tab des Dashboards **Datenquelle: MetaTrader** wählen. Der Live-Bot nutzt weiter TradingView.

Die Kerzenzeiten von MetaTrader sind die Serveruhr des Brokers, die meist mit der Sommerzeit wandert. Der Import findet die Uhr selbst, indem er die Kerzen mit den vom Bot archivierten TradingView-Kerzen abgleicht (führe also zuerst einen 1-Stunden-Backtest mit TradingView-Daten und vielen Kerzen aus, z. B. auf EURUSD, damit das TradingView-Archiv über eine Sommerzeitumstellung zurückreicht) und **speichert nichts, was er nicht belegen kann**, und nennt den Grund. MetaTrader-Kerzen landen in einem getrennten Archiv und werden nie mit TradingView-Daten gemischt; jeder Import ersetzt dieses Archiv. Die Uhr wird einmal pro Broker-Server aus allen seinen Dateien zusammen bestimmt, und nur TradingView-Kerzen, die eine Sommerzeitumstellung überspannen, können zwischen den möglichen Uhrenmodellen entscheiden: das richtige Modell setzt deutlich weniger Kerzen daneben. Aus Handelszeiten wird nichts geraten (auf einem echten Server lieferte das die falsche Antwort). Ohne diesen Beweis lehnt der Import ab und sagt es; verlängere das TradingView-Archiv wie beschrieben oder gib die Uhr selbst an (`--offset eu:0` = Osteuropa mit europäischer Sommerzeit, `--offset ny:7` = New York + 7 Stunden). Alle anderen Symbole und Zeitrahmen desselben Servers sowie die Tages-/Wochen-/Monatsdateien nutzen diese Serveruhr. Die Preise der Broker unterscheiden sich leicht, Ergebnisse auf MetaTrader-Daten sind also nicht identisch mit TradingView. Das MQL5-Skript konnte in der Entwicklungsumgebung nicht kompiliert werden: erst auf einem Demokonto testen.

## Märkte und Broker

| Markt | Anbieter | Schlüssel |
|---|---|---|
| Krypto-Spot | Binance, Bybit, OKX, KuCoin, Kraken, Coinbase, Bitget, Gate.io, MEXC (über ccxt) | `*_KEY`, `*_SECRET` (+ `*_PASSPHRASE` bei OKX, KuCoin, Bitget) |
| US-Aktien | Alpaca (standardmäßig Paper) | `ALPACA_KEY`, `ALPACA_SECRET` |
| Forex und Gold | OANDA (standardmäßig Practice) | `OANDA_TOKEN`, `OANDA_ACCOUNT_ID` |

Verwende API-Schlüssel **nur mit Handelsberechtigung, niemals mit Auszahlungsrecht**. Ob ein Dienst für dich verfügbar ist, hängt von den Gesetzen deines Landes und den Bedingungen des Dienstes ab.

## Telegram

Erstelle einen Bot mit `@BotFather` und verbinde ihn über das Dashboard-Panel oder die `.env`. Du erhältst Signalmeldungen, Start- und Ausfallhinweise, eine tägliche Zusammenfassung und einen wöchentlichen Evidenzbericht. Gesteuert werden kann der Bot nur aus dem registrierten Chat: `/status`, `/positions`, `/pnl`, `/close BTCUSDT`, `/halt`, `/resume`, `/panic`. Ein optionaler HTTP-Proxy wird nur für Telegram unterstützt.

## Bevor du echtes Geld einsetzt

1. `npm test`
2. `npm run backtest` und `npm run sweep` mit echten Daten
3. `MODE=paper` über mehrere Wochen
4. `MODE=live` auf einem Testnet- oder Demokonto (`EXCHANGE_TESTNET=YES`, `ALPACA_PAPER=YES`, `OANDA_PRACTICE=YES`)
5. Erst danach: echte Schlüssel, ein sehr kleines `capitalUsdt` und `LIVE_CONFIRM=YES`

## Projektstruktur

| Datei | Zweck |
|---|---|
| `server.js` | HTTP-Server, Dashboard und API |
| `bot.js` | Trading-Bot und Risikobehandlung |
| `strategy.js`, `rules.js`, `custom-strategies*.js` | Indikatoren, Strategien und eigene Regeln |
| `risk.js`, `config.js`, `config-overrides.js` | Positionsgröße, Limits und Einstellungen |
| `backtest*.js`, `significance.js`, `trials.js`, `evidence.js` | Backtesting und statistische Validierung |
| `history-import.js`, `candle-store.js` | Import langer Historien und Kerzenarchiv |
| `mt5-import.js`, `mt5/TvHubExport.mq5`, `import-mt5.bat` | Lange Gold-/Forex-Historie aus MetaTrader 5 (getrenntes Archiv) |
| `broker-alpaca.js`, `broker-oanda.js` | Aktien- und Forex-Broker |
| `telegram*.js`, `notify.js`, `summary.js` | Telegram und Benachrichtigungen |
| `ai*.js` | Optionaler KI-Strategiehelfer |
| `public/` | Dashboard-Frontend |

## Tests

```bash
npm test
```

Die Testsuite läuft offline gegen simulierte Börsen und Broker und deckt Risikologik, Broker, Backtesting, Statistik, Benachrichtigungen, Zuverlässigkeit, eigene Strategien, den KI-Helfer, Live-Handelssicherheit und mehr ab.

## Bekannte Einschränkungen

- Die Marktdaten stammen aus einer inoffiziellen TradingView-Bibliothek, die bei Änderungen von TradingView ausfallen kann.
- Stop-Loss und Take-Profit werden von der App überwacht. Börsenseitige Stops sind für Krypto standardmäßig aktiv, ein Trailing-Stop bewegt sich aber nur innerhalb der App (bei Alpaca und OANDA bleibt der brokerseitige Stop fest).
- Kurslücken (Gaps) können zu Verlusten über den Stop hinaus führen.
- Der Import langer Historien funktioniert nur für Binance-Spot; Aktien und Forex sind auf TradingView-Daten und das wachsende lokale Archiv beschränkt.
- Die englische Übersetzung deckt die ganze App ab, aber eine selten auftretende Meldung kann noch auf Persisch erscheinen. Im Dashboard listet `I18N_MISSING()` in der Browser-Konsole solche Texte auf.

## Mitwirkende

Erstellt von **Ehsan Bagheryane** ([@medad21](https://github.com/medad21)).

Aufgebaut auf [@mathieuc/tradingview](https://github.com/Mathieu2301/TradingView-API), [ccxt](https://github.com/ccxt/ccxt), [Express](https://expressjs.com) und [ws](https://github.com/websockets/ws).
