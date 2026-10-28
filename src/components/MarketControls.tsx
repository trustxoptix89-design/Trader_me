import { RefreshCw } from "lucide-react";
import { useMarket } from "@/providers/market";
import type { Exchange, Interval } from "@contracts/types";

export function MarketControls({ compact = false }: { compact?: boolean }) {
  const { exchange, symbol, interval, setExchange, setSymbol, setInterval, refresh, loading } = useMarket();
  return <form className={`market-controls ${compact ? "compact" : ""}`} onSubmit={(e) => { e.preventDefault(); void refresh(); }}>
    <label><span>دارایی</span><select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"].map((s) => <option key={s}>{s}</option>)}</select></label>
    <label><span>صرافی</span><select value={exchange} onChange={(e) => setExchange(e.target.value as Exchange)}><option value="binance">Binance USDⓈ-M</option><option value="bybit">Bybit Linear</option></select></label>
    <label><span>تایم‌فریم</span><select value={interval} onChange={(e) => setInterval(e.target.value as Interval)}>{["5m", "15m", "30m", "1h", "4h"].map((v) => <option key={v}>{v}</option>)}</select></label>
    <button className="button primary" type="submit" disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""} />{loading ? "در حال بررسی" : "اجرای تحلیل واقعی"}</button>
  </form>;
}
