import { useEffect, useRef } from "react";
import type { Interval } from "@contracts/types";

const TV_INTERVAL: Record<Interval, string> = { "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D" };

/**
 * Free TradingView Advanced Chart widget: full drawing tools and indicators for any symbol.
 * Display only — it needs no exchange account and the app never trades.
 */
export function TradingViewChart({ symbol, interval, exchange }: { symbol: string; interval: Interval; exchange: "binance" | "bybit" }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = "100%";
    el.appendChild(inner);
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: `${exchange === "bybit" ? "BYBIT" : "BINANCE"}:${symbol}.P`,
      interval: TV_INTERVAL[interval],
      timezone: "Asia/Tehran",
      theme: "dark",
      style: "1",
      locale: "fa_IR",
      allow_symbol_change: true,
      withdateranges: true,
      hide_side_toolbar: false,
      save_image: true,
      support_host: "https://www.tradingview.com",
    });
    el.appendChild(script);
    return () => { el.innerHTML = ""; };
  }, [symbol, interval, exchange]);
  return <div ref={host} className="tradingview-widget-container tv-chart" dir="ltr" aria-label={`چارت TradingView ${symbol}`} />;
}
