//+------------------------------------------------------------------+
//| TvHubExport.mq5                                                  |
//| Exports candles to CSV files in MetaTrader's shared "Common"     |
//| folder, for tv-hub (run `node mt5-import.js` afterwards).        |
//|                                                                  |
//| Install: copy this file to <MT5 data folder>\MQL5\Scripts        |
//|   (MT5: File > Open Data Folder), open it in MetaEditor (F4),    |
//|   press Compile (F7), then drag it from Navigator > Scripts      |
//|   onto any chart. It only READS history; it never trades.        |
//+------------------------------------------------------------------+
#property copyright "tv-hub"
#property version   "1.00"
#property description "Exports candles to CSV in the shared Common\\Files folder for tv-hub. Read-only: it never trades."
#property script_show_inputs

enum ENUM_SYMBOL_MODE
  {
   MODE_CHART  = 0, // This chart's symbol only
   MODE_WATCH  = 1, // Every symbol in Market Watch (add symbols there: Ctrl+U)
   MODE_PRESET = 2, // Gold, silver and the 7 major forex pairs
   MODE_CUSTOM = 3  // The list typed in "Custom symbols" below
  };

input ENUM_SYMBOL_MODE InpSymbolMode = MODE_PRESET; // Which symbols to export
input string InpCustomSymbols = "XAUUSD,EURUSD";    // Custom symbols (only used with "The list typed..."), comma separated
input bool   InpM1   = false;  // M1  - 1 minute (the terminal keeps only a few months of it)
input bool   InpM5   = false;  // M5  - 5 minutes
input bool   InpM15  = true;   // M15 - 15 minutes
input bool   InpM30  = false;  // M30 - 30 minutes
input bool   InpH1   = true;   // H1  - 1 hour
input bool   InpH4   = true;   // H4  - 4 hours
input bool   InpD1   = true;   // D1  - daily
input bool   InpW1   = false;  // W1  - weekly
input bool   InpMN1  = false;  // MN1 - monthly
input int    InpMaxBars = 100000;      // Most candles per file (the terminal's "Max bars in chart" also limits this)
input string InpFolder  = "tvhub-mt5"; // Folder inside the shared Common\Files folder

//--- adds a symbol to the list once (trimmed, no duplicates)
void AddSymbol(string &list[], int &n, string s)
  {
   StringTrimLeft(s);
   StringTrimRight(s);
   if(s == "")
      return;
   for(int i = 0; i < n; i++)
      if(list[i] == s)
         return;
   ArrayResize(list, n + 1);
   list[n] = s;
   n++;
  }

//--- the symbols chosen in the dialog
int CollectSymbols(string &syms[])
  {
   int n = 0;
   ArrayResize(syms, 0);
   if(InpSymbolMode == MODE_CHART)
      AddSymbol(syms, n, _Symbol);
   else
      if(InpSymbolMode == MODE_WATCH)
        {
         int total = SymbolsTotal(true);
         for(int i = 0; i < total; i++)
            AddSymbol(syms, n, SymbolName(i, true));
        }
      else
         if(InpSymbolMode == MODE_PRESET)
           {
            string preset[] = {"XAUUSD", "XAGUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD"};
            for(int i = 0; i < ArraySize(preset); i++)
               AddSymbol(syms, n, preset[i]);
           }
         else
           {
            string parts[];
            int k = StringSplit(InpCustomSymbols, ',', parts);
            for(int i = 0; i < k; i++)
               AddSymbol(syms, n, parts[i]);
           }
   return n;
  }

void AddTf(string &names[], ENUM_TIMEFRAMES &tfs[], int &n, const bool on, const string name, const ENUM_TIMEFRAMES tf)
  {
   if(!on)
      return;
   ArrayResize(names, n + 1);
   ArrayResize(tfs, n + 1);
   names[n] = name;
   tfs[n] = tf;
   n++;
  }

//--- the timeframes ticked in the dialog
int CollectTimeframes(string &names[], ENUM_TIMEFRAMES &tfs[])
  {
   int n = 0;
   ArrayResize(names, 0);
   ArrayResize(tfs, 0);
   AddTf(names, tfs, n, InpM1,  "M1",  PERIOD_M1);
   AddTf(names, tfs, n, InpM5,  "M5",  PERIOD_M5);
   AddTf(names, tfs, n, InpM15, "M15", PERIOD_M15);
   AddTf(names, tfs, n, InpM30, "M30", PERIOD_M30);
   AddTf(names, tfs, n, InpH1,  "H1",  PERIOD_H1);
   AddTf(names, tfs, n, InpH4,  "H4",  PERIOD_H4);
   AddTf(names, tfs, n, InpD1,  "D1",  PERIOD_D1);
   AddTf(names, tfs, n, InpW1,  "W1",  PERIOD_W1);
   AddTf(names, tfs, n, InpMN1, "MN1", PERIOD_MN1);
   return n;
  }

//--- file-name safe version of a symbol ("XAUUSD.a" -> "XAUUSD_a")
string SafeName(const string s)
  {
   string out = "";
   int n = StringLen(s);
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(s, i);
      bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '-' || c == '_';
      if(ok)
         out += CharToString((uchar)c);
      else
         out += "_";
     }
   return out;
  }

//--- one symbol + one timeframe -> one CSV file
bool ExportOne(const string sym, const string tfName, const ENUM_TIMEFRAMES tf)
  {
   if(!SymbolSelect(sym, true))
     {
      PrintFormat("TvHubExport: symbol %s does not exist on this server - skipped", sym);
      return false;
     }

   MqlRates rates[];
   ArraySetAsSeries(rates, false);          // oldest candle first

   // the terminal builds / downloads the series in the background: ask again until the count stops changing
   int prev = -1, got = -1;
   for(int a = 0; a < 60 && !IsStopped(); a++)
     {
      got = CopyRates(sym, tf, 0, InpMaxBars, rates);
      if(got > 0 && got == prev && (bool)SeriesInfoInteger(sym, tf, SERIES_SYNCHRONIZED))
         break;
      prev = got;
      Sleep(500);
     }
   if(got < 3)
     {
      PrintFormat("TvHubExport: no candles for %s %s (got %d, error %d) - skipped", sym, tfName, got, GetLastError());
      return false;
     }

   string path = InpFolder + "\\" + SafeName(sym) + "_" + tfName + ".csv";
   int h = FileOpen(path, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(h == INVALID_HANDLE)
     {
      PrintFormat("TvHubExport: cannot write %s (error %d)", path, GetLastError());
      return false;
     }

   // header: lines starting with # are information for tv-hub; the times in the table are the SERVER clock (tv-hub converts them to UTC)
   FileWriteString(h, "#tvhub-mt5,1\n");
   FileWriteString(h, "#server," + AccountInfoString(ACCOUNT_SERVER) + "\n");
   FileWriteString(h, "#company," + AccountInfoString(ACCOUNT_COMPANY) + "\n");
   FileWriteString(h, "#symbol," + sym + "\n");
   FileWriteString(h, "#tf," + tfName + "\n");
   FileWriteString(h, "#exported_gmt," + IntegerToString((long)TimeGMT()) + "\n");
   FileWriteString(h, "#server_now," + IntegerToString((long)TimeTradeServer()) + "\n");
   FileWriteString(h, "time,open,high,low,close,tick_volume,spread\n");

   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   int rows = 0;
   // the last candle is still forming: leave it out (tv-hub only stores CLOSED candles)
   for(int i = 0; i < got - 1; i++)
     {
      string line = StringFormat("%I64d,%s,%s,%s,%s,%I64d,%d\n",
                                 (long)rates[i].time,
                                 DoubleToString(rates[i].open,  digits),
                                 DoubleToString(rates[i].high,  digits),
                                 DoubleToString(rates[i].low,   digits),
                                 DoubleToString(rates[i].close, digits),
                                 (long)rates[i].tick_volume,
                                 rates[i].spread);
      FileWriteString(h, line);
      rows++;
     }
   FileClose(h);

   PrintFormat("TvHubExport: %s %s -> %d candles (%s .. %s) saved to Common\\Files\\%s",
               sym, tfName, rows,
               TimeToString(rates[0].time, TIME_DATE | TIME_MINUTES),
               TimeToString(rates[got - 2].time, TIME_DATE | TIME_MINUTES), path);
   return true;
  }

//+------------------------------------------------------------------+
void OnStart()
  {
   string syms[];
   int ns = CollectSymbols(syms);
   string tfNames[];
   ENUM_TIMEFRAMES tfs[];
   int nt = CollectTimeframes(tfNames, tfs);
   if(ns == 0 || nt == 0)
     {
      Alert("TvHubExport: nothing to export - choose at least one symbol and tick at least one timeframe.");
      return;
     }

   FolderCreate(InpFolder, FILE_COMMON);    // false when it already exists - that is fine

   int ok = 0, tried = 0;
   for(int i = 0; i < ns && !IsStopped(); i++)
      for(int j = 0; j < nt && !IsStopped(); j++)
        {
         tried++;
         if(ExportOne(syms[i], tfNames[j], tfs[j]))
            ok++;
        }

   string where = TerminalInfoString(TERMINAL_COMMONDATA_PATH) + "\\Files\\" + InpFolder;
   string msg = StringFormat("TvHubExport finished: %d of %d files written to %s", ok, tried, where);
   Print(msg);
   Comment(msg);
   Alert(msg);
  }
//+------------------------------------------------------------------+
