//+------------------------------------------------------------------+
//| TvHubLive.mq5                                                    |
//| Writes a LIVE snapshot (price, spread, newest candles, open      |
//| positions, account totals) as one small JSON file per symbol in  |
//| MetaTrader's shared "Common" folder, for tv-hub to read.         |
//|                                                                  |
//| READ-ONLY: it never sends, changes or closes an order.           |
//| It does not need "Algo Trading" to be switched on.               |
//|                                                                  |
//| Install: copy this file to <MT5 data folder>\MQL5\Experts        |
//|   (MT5: File > Open Data Folder), open it in MetaEditor (F4),    |
//|   press Compile (F7), then drag it from Navigator > Expert       |
//|   Advisors onto ONE chart (any symbol, any timeframe).           |
//| Output: <Common>\Files\tvhub-mt5\live\<SYMBOL>.json              |
//|   (Common = %APPDATA%\MetaQuotes\Terminal\Common)                |
//+------------------------------------------------------------------+
#property copyright "tv-hub"
#property version   "1.00"
#property description "Live read-only snapshot for tv-hub (price, candles, positions, account totals). Never trades."

input string InpSymbols   = "XAUUSD";        // Symbols to publish (comma separated, exactly as your broker names them)
input bool   InpM15       = true;            // Publish M15 candles
input bool   InpH1        = true;            // Publish H1 candles
input bool   InpH4        = true;            // Publish H4 candles
input bool   InpD1        = true;            // Publish D1 candles
input int    InpBars      = 300;             // Closed candles per timeframe (tv-hub looks at the newest 300)
input int    InpEverySec  = 5;               // How often to write (seconds)
input bool   InpPositions = true;            // Include open positions (ticket, type, volume, prices, profit)
input bool   InpAccount   = true;            // Include account totals (balance, equity, margin). Never the login number or the name.
input string InpFolder    = "tvhub-mt5\\live"; // Folder inside the shared Common\Files folder

string g_syms[];
long   g_seq = 0;

//--- text -> JSON string (quotes, backslashes and control characters made safe)
string J(const string s)
  {
   string o = "\"";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      if(c == '"' || c == '\\')
        {
         o += "\\";
         o += ShortToString(c);
        }
      else
         if(c < 32)
            o += " ";
         else
            o += ShortToString(c);
     }
   return o + "\"";
  }

//--- file-name safe version of a symbol ("XAUUSD.a" -> "XAUUSD_a"); must match what tv-hub expects
string SafeName(const string s)
  {
   string out = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '.' || c == '-';
      out += ok ? ShortToString(c) : "_";
     }
   return out;
  }

string Num(const double v, const int digits)
  {
   if(!MathIsValidNumber(v))
      return "null";
   return DoubleToString(v, digits);
  }

string Iso(const datetime t)
  {
   return IntegerToString((long)t);
  }

//--- the candles of one timeframe as  {"tf":"H1","closed":[[time,o,h,l,c,tickvol],...],"forming":[...]}
//    times are the SERVER clock in seconds (tv-hub converts them with server_utc_offset_sec)
string Candles(const string sym, const ENUM_TIMEFRAMES tf, const string name, const int digits)
  {
   MqlRates r[];
   ArraySetAsSeries(r, false);                     // oldest -> newest
   int want = InpBars + 1;                         // +1: the last one is still forming
   int got = CopyRates(sym, tf, 0, want, r);
   if(got < 2)
      return "";                                   // history not loaded yet: try again next round
   string s = "{\"tf\":" + J(name) + ",\"closed\":[";
   for(int i = 0; i < got - 1; i++)
     {
      if(i > 0)
         s += ",";
      s += "[" + Iso(r[i].time) + "," + Num(r[i].open, digits) + "," + Num(r[i].high, digits) + "," + Num(r[i].low, digits) + "," + Num(r[i].close, digits) + "," + IntegerToString((long)r[i].tick_volume) + "]";
     }
   int f = got - 1;
   s += "],\"forming\":[" + Iso(r[f].time) + "," + Num(r[f].open, digits) + "," + Num(r[f].high, digits) + "," + Num(r[f].low, digits) + "," + Num(r[f].close, digits) + "," + IntegerToString((long)r[f].tick_volume) + "]}";
   return s;
  }

string Positions(const string sym)
  {
   string s = "[";
   bool first = true;
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);           // selects the position
      if(ticket == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) != sym)
         continue;
      long   type = PositionGetInteger(POSITION_TYPE);
      int    dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      if(!first)
         s += ",";
      first = false;
      s += "{\"ticket\":" + IntegerToString((long)ticket)
           + ",\"type\":" + J(type == POSITION_TYPE_BUY ? "buy" : "sell")
           + ",\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2)
           + ",\"open\":" + Num(PositionGetDouble(POSITION_PRICE_OPEN), dg)
           + ",\"sl\":" + Num(PositionGetDouble(POSITION_SL), dg)
           + ",\"tp\":" + Num(PositionGetDouble(POSITION_TP), dg)
           + ",\"profit\":" + Num(PositionGetDouble(POSITION_PROFIT), 2)
           + ",\"swap\":" + Num(PositionGetDouble(POSITION_SWAP), 2)
           + ",\"time\":" + Iso((datetime)PositionGetInteger(POSITION_TIME)) + "}";
     }
   return s + "]";
  }

string Account()
  {
   return "{\"currency\":" + J(AccountInfoString(ACCOUNT_CURRENCY))
          + ",\"balance\":" + Num(AccountInfoDouble(ACCOUNT_BALANCE), 2)
          + ",\"equity\":" + Num(AccountInfoDouble(ACCOUNT_EQUITY), 2)
          + ",\"margin\":" + Num(AccountInfoDouble(ACCOUNT_MARGIN), 2)
          + ",\"margin_free\":" + Num(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2)
          + ",\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + "}";
  }

//--- one symbol -> one JSON file, written to a temp name first, then renamed (tv-hub never sees a half-written file)
bool Publish(const string sym)
  {
   if(!SymbolSelect(sym, true))
      return false;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   MqlTick tick;
   if(!SymbolInfoTick(sym, tick))
      return false;

   string tfs = "";
   int cnt = 0;
   string one;
   if(InpM15) { one = Candles(sym, PERIOD_M15, "M15", digits); if(one != "") { tfs += (cnt++ > 0 ? "," : "") + one; } }
   if(InpH1)  { one = Candles(sym, PERIOD_H1,  "H1",  digits); if(one != "") { tfs += (cnt++ > 0 ? "," : "") + one; } }
   if(InpH4)  { one = Candles(sym, PERIOD_H4,  "H4",  digits); if(one != "") { tfs += (cnt++ > 0 ? "," : "") + one; } }
   if(InpD1)  { one = Candles(sym, PERIOD_D1,  "D1",  digits); if(one != "") { tfs += (cnt++ > 0 ? "," : "") + one; } }
   if(cnt == 0)
      return false;

   g_seq++;
   datetime server = TimeTradeServer();
   datetime gmt = TimeGMT();
   long offset = (long)(server - gmt);              // server clock minus UTC, in seconds, RIGHT NOW

   string j = "{\"v\":1,\"seq\":" + IntegerToString(g_seq)
              + ",\"symbol\":" + J(sym)
              + ",\"server\":" + J(AccountInfoString(ACCOUNT_SERVER))
              + ",\"company\":" + J(AccountInfoString(ACCOUNT_COMPANY))
              + ",\"written_gmt\":" + IntegerToString((long)gmt)
              + ",\"server_time\":" + IntegerToString((long)server)
              + ",\"server_utc_offset_sec\":" + IntegerToString(offset)
              + ",\"terminal_connected\":" + (TerminalInfoInteger(TERMINAL_CONNECTED) ? "true" : "false")
              + ",\"digits\":" + IntegerToString(digits)
              + ",\"point\":" + DoubleToString(SymbolInfoDouble(sym, SYMBOL_POINT), 10)
              + ",\"contract_size\":" + Num(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 4)
              + ",\"volume_min\":" + Num(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 4)
              + ",\"volume_step\":" + Num(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 4)
              + ",\"stops_level_points\":" + IntegerToString(SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL))
              + ",\"trade_mode\":" + IntegerToString(SymbolInfoInteger(sym, SYMBOL_TRADE_MODE))
              + ",\"tick\":{\"time\":" + IntegerToString((long)tick.time) + ",\"bid\":" + Num(tick.bid, digits) + ",\"ask\":" + Num(tick.ask, digits)
              + ",\"spread_points\":" + IntegerToString(SymbolInfoInteger(sym, SYMBOL_SPREAD)) + "}"
              + ",\"timeframes\":[" + tfs + "]";
   if(InpPositions)
      j += ",\"positions\":" + Positions(sym);
   if(InpAccount)
      j += ",\"account\":" + Account();
   j += "}";

   string target = InpFolder + "\\" + SafeName(sym) + ".json";
   string tmp = target + ".tmp";
   uchar bytes[];
   int len = StringToCharArray(j, bytes, 0, WHOLE_ARRAY, CP_UTF8) - 1;   // UTF-8 without the trailing zero byte
   if(len < 2)
      return false;
   int h = FileOpen(tmp, FILE_WRITE | FILE_BIN | FILE_COMMON);
   if(h == INVALID_HANDLE)
     {
      Print("TvHubLive: cannot write ", tmp, " (error ", GetLastError(), ")");
      return false;
     }
   FileWriteArray(h, bytes, 0, len);
   FileClose(h);
   if(!FileMove(tmp, FILE_COMMON, target, FILE_REWRITE | FILE_COMMON))
     {
      Print("TvHubLive: cannot rename ", tmp, " (error ", GetLastError(), ")");
      FileDelete(tmp, FILE_COMMON);
      return false;
     }
   return true;
  }

int OnInit()
  {
   ArrayResize(g_syms, 0);
   string parts[];
   int k = StringSplit(InpSymbols, ',', parts);
   for(int i = 0; i < k; i++)
     {
      string s = parts[i];
      StringTrimLeft(s);
      StringTrimRight(s);
      if(s == "")
         continue;
      int n = ArraySize(g_syms);
      ArrayResize(g_syms, n + 1);
      g_syms[n] = s;
     }
   if(ArraySize(g_syms) == 0)
     {
      Print("TvHubLive: no symbols given");
      return INIT_PARAMETERS_INCORRECT;
     }
   if(InpBars < 60 || InpBars > 2000 || InpEverySec < 1)
     {
      Print("TvHubLive: Bars must be 60..2000 and the interval at least 1 second");
      return INIT_PARAMETERS_INCORRECT;
     }
   FolderCreate("tvhub-mt5", FILE_COMMON);
   FolderCreate(InpFolder, FILE_COMMON);
   EventSetTimer(InpEverySec);
   OnTimer();                                       // first snapshot right away
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   for(int i = 0; i < ArraySize(g_syms); i++)
      Publish(g_syms[i]);
  }

//--- ticks are not needed: the timer does everything
void OnTick() {}
//+------------------------------------------------------------------+
