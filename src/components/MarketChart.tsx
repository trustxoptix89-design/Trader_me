import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, createChart,
  type ISeriesApi, type LineWidth, type SeriesType, type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, Signal } from "@contracts/types";
import { atrSeries, emaSeries, macdSeries, rsiSeries, swingLevels, vwapSeries } from "@contracts/indicators";
import { dateTime, price } from "@/lib/format";

type Toggle = "ema" | "vwap" | "levels" | "rsi" | "macd" | "atr";
const TOGGLES: { key: Toggle; label: string }[] = [
  { key: "ema", label: "EMA 20/50" }, { key: "vwap", label: "VWAP" }, { key: "levels", label: "حمایت/مقاومت" },
  { key: "rsi", label: "RSI" }, { key: "macd", label: "MACD" }, { key: "atr", label: "ATR" },
];
const UP = "#34d399", DOWN = "#f87171", CYAN = "#22d3ee", AMBER = "#fbbf24", VIOLET = "#a78bfa", MUTED = "#94a3b8";
const MAIN_HEIGHT = 340, PANE_HEIGHT = 110, VISIBLE_BARS = 140;

const ts = (c: Candle) => Math.floor(c.time / 1000) as UTCTimestamp;
const toLine = (candles: Candle[], values: (number | null)[]) =>
  candles.flatMap((c, i) => (values[i] === null || values[i] === undefined ? [] : [{ time: ts(c), value: values[i] as number }]));

interface Props { candles: Candle[]; higher?: Candle[]; interval?: string; signal?: Signal | null }

/**
 * Candlestick chart (TradingView's open-source Lightweight Charts) with indicator panes.
 * Every indicator is computed by @contracts/indicators, the same module the analysis engine and backtest import.
 */
export function MarketChart({ candles, higher, interval = "", signal }: Props) {
  const [view, setView] = useState<"base" | "higher">("base");
  const [on, setOn] = useState<Record<Toggle, boolean>>({ ema: true, vwap: true, levels: true, rsi: true, macd: true, atr: false });
  const host = useRef<HTMLDivElement | null>(null);
  const hasHigher = !!higher?.length && interval !== "4h";
  const data = view === "higher" && hasHigher ? higher! : candles;
  const paneCount = [on.rsi, on.macd, on.atr].filter(Boolean).length;
  const height = MAIN_HEIGHT + paneCount * PANE_HEIGHT;
  const calc = useMemo(() => {
    const closes = data.map((c) => c.close);
    return { ema20: emaSeries(closes, 20), ema50: emaSeries(closes, 50), vwap: vwapSeries(data), rsi: rsiSeries(closes), macd: macdSeries(closes), atr: atrSeries(data), levels: swingLevels(data) };
  }, [data]);

  useEffect(() => {
    const el = host.current;
    if (!el || !data.length) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: MUTED, fontSize: 11, panes: { separatorColor: "#243041" } },
      grid: { vertLines: { color: "rgba(148,163,184,.08)" }, horzLines: { color: "rgba(148,163,184,.08)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#243041" },
      timeScale: { borderColor: "#243041", timeVisible: true, secondsVisible: false },
    });
    const line = (color: string, pane: number, width: LineWidth = 1, title = "") =>
      chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, title }, pane);

    const candle = chart.addSeries(CandlestickSeries, { upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN }, 0);
    candle.setData(data.map((c) => ({ time: ts(c), open: c.open, high: c.high, low: c.low, close: c.close })));
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", priceLineVisible: false, lastValueVisible: false }, 0);
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(data.map((c) => ({ time: ts(c), value: c.volume, color: c.close >= c.open ? "rgba(52,211,153,.35)" : "rgba(248,113,113,.35)" })));

    if (on.ema) { line(CYAN, 0, 1, "EMA20").setData(toLine(data, calc.ema20)); line(AMBER, 0, 1, "EMA50").setData(toLine(data, calc.ema50)); }
    if (on.vwap) line(VIOLET, 0, 1, "VWAP").setData(toLine(data, calc.vwap));

    const guide = (series: ISeriesApi<SeriesType>, value: number, color: string, title: string, style = LineStyle.Dashed) =>
      series.createPriceLine({ price: value, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    if (on.levels) {
      calc.levels.resistance.forEach((v) => guide(candle, v, "rgba(248,113,113,.75)", "مقاومت"));
      calc.levels.support.forEach((v) => guide(candle, v, "rgba(52,211,153,.75)", "حمایت"));
    }
    if (signal && signal.status === "approved" && view === "base") {
      if (signal.entryLow !== null) guide(candle, signal.entryLow, CYAN, "ورود", LineStyle.Solid);
      if (signal.entryHigh !== null && signal.entryHigh !== signal.entryLow) guide(candle, signal.entryHigh, CYAN, "ورود", LineStyle.Solid);
      if (signal.stopLoss !== null) guide(candle, signal.stopLoss, DOWN, "حد ضرر", LineStyle.Solid);
      signal.targets.forEach((t, i) => guide(candle, t, UP, `هدف ${i + 1}`, LineStyle.Solid));
    }

    let pane = 1;
    if (on.rsi) {
      const rsi = line(CYAN, pane, 2, "RSI 14"); rsi.setData(toLine(data, calc.rsi));
      guide(rsi, 70, "rgba(248,113,113,.5)", "70"); guide(rsi, 30, "rgba(52,211,153,.5)", "30"); pane++;
    }
    if (on.macd) {
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, title: "Hist" }, pane);
      hist.setData(data.flatMap((c, i) => { const v = calc.macd.histogram[i]; return v === null ? [] : [{ time: ts(c), value: v, color: v >= 0 ? "rgba(52,211,153,.55)" : "rgba(248,113,113,.55)" }]; }));
      line(CYAN, pane, 1, "MACD").setData(toLine(data, calc.macd.macd)); line(AMBER, pane, 1, "Signal").setData(toLine(data, calc.macd.signal)); pane++;
    }
    if (on.atr) { line(VIOLET, pane, 2, "ATR 14").setData(toLine(data, calc.atr)); pane++; }

    const panes = chart.panes();
    panes[0]?.setHeight(MAIN_HEIGHT);
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(PANE_HEIGHT);
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - VISIBLE_BARS), to: data.length + 3 });
    return () => chart.remove();
  }, [data, calc, on, signal, view]);

  if (!candles.length) return null;
  return <div className="chart-wrap market-chart" dir="ltr">
    <div className="chart-toolbar" dir="rtl">
      {hasHigher && <div className="chart-tabs" role="tablist" aria-label="بازهٔ زمانی نمودار">
        <button type="button" role="tab" aria-selected={view === "base"} className={view === "base" ? "on" : ""} onClick={() => setView("base")}>{interval}</button>
        <button type="button" role="tab" aria-selected={view === "higher"} className={view === "higher" ? "on" : ""} onClick={() => setView("higher")}>4h</button>
      </div>}
      {TOGGLES.map((t) => <label key={t.key} className="chart-toggle"><input type="checkbox" checked={on[t.key]} onChange={() => setOn((s) => ({ ...s, [t.key]: !s[t.key] }))} />{t.label}</label>)}
    </div>
    <div ref={host} style={{ height }} role="img" aria-label={`نمودار ${data.length} کندل از ${dateTime(data[0].time)} تا ${dateTime(data.at(-1)!.time)}؛ اندیکاتورها از همان موتور تحلیل محاسبه شده‌اند`} />
    <div className="chart-note" dir="rtl">اندیکاتورها با همان ماژول موتور تحلیل و بک‌تست محاسبه می‌شوند · آخرین قیمت {price(data.at(-1)!.close)} · نمودار: Lightweight Charts (Apache-2.0، © TradingView)</div>
  </div>;
}

export function EquityChart({ points }: { points: { time: number; equity: number; sample: "train" | "test" }[] }) {
  if (points.length < 2) return <div className="mini-empty">منحنی سرمایه پس از ثبت معامله ساخته می‌شود.</div>;
  const W = 800, H = 240, min = Math.min(...points.map((p) => p.equity)), max = Math.max(...points.map((p) => p.equity)), range = max - min || 1;
  const coords = points.map((p, i) => `${20 + i * 760 / (points.length - 1)},${20 + (max - p.equity) / range * 180}`).join(" ");
  const split = points.findIndex((p) => p.sample === "test");
  return <svg className="equity-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="منحنی سرمایهٔ بک‌تست">
    <line x1="20" x2="780" y1="200" y2="200" className="grid-line" />
    {split > 0 && <line x1={20 + split * 760 / (points.length - 1)} x2={20 + split * 760 / (points.length - 1)} y1="12" y2="205" className="split-line" />}
    <polyline points={coords} fill="none" stroke="#22d3ee" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    <text x="20" y="228" className="axis-text">{price(min)}</text><text x="710" y="228" className="axis-text">{price(max)}</text>
  </svg>;
}
