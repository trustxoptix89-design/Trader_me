import { useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, CheckCircle2, CircleDashed, Database, FlaskConical, ShieldAlert } from "lucide-react";
import { useMarket } from "@/providers/market";
import { MarketControls } from "@/components/MarketControls";
import { MarketChart } from "@/components/MarketChart";
import { TradingViewChart } from "@/components/TradingViewChart";
import { SignalCard } from "@/components/SignalCard";
import { EmptyState, ErrorState, LoadingState, Metric, PageTitle, Panel, StatusBadge } from "@/components/Common";
import { age, dateTime, fmt, pct, price } from "@/lib/format";

export default function Dashboard() {
  const { result, loading, error, refresh } = useMarket();
  const [chartMode, setChartMode] = useState<"signal" | "tv">("signal");
  return <>
    <PageTitle eyebrow="MISSION CONTROL / REAL DATA" title="مرکز تصمیم معاملات" description="تحلیل، داوری و ریسک در یک مسیر قابل ردیابی؛ بدون عدد نمونه و بدون سفارش واقعی." />
    <MarketControls />
    {loading && <LoadingState label="در حال دریافت داده و اجرای ۲۰ بررسی…" />}
    {!loading && error && <ErrorState error={error} retry={() => void refresh()} />}
    {!loading && !error && !result && <EmptyState title="هنوز تحلیلی اجرا نشده" detail="برای شروع، دارایی و صرافی را انتخاب و اتصال واقعی را اجرا کنید. نتیجهٔ احتمالی می‌تواند «عدم ورود» باشد." />}
    {result && <div className="dashboard-grid">
      <Panel className="market-panel" title={`${result.snapshot.symbol} / ${result.snapshot.interval}`} action={<StatusBadge tone={result.snapshot.isFresh ? "good" : "bad"}>{result.snapshot.isFresh ? "تازه" : "کهنه"}</StatusBadge>}>
        <div className="quote-row"><div><span>قیمت Close کندل بسته</span><strong dir="ltr">{price(result.metrics.price)}</strong></div><span className={Number(result.metrics.priceChangePct) >= 0 ? "positive" : "negative"}>{pct(result.metrics.priceChangePct)}</span></div>
        <div className="chart-tabs" role="group" aria-label="نوع چارت">
          <button type="button" aria-pressed={chartMode === "signal"} onClick={() => setChartMode("signal")}>چارت سیگنال</button>
          <button type="button" aria-pressed={chartMode === "tv"} onClick={() => setChartMode("tv")}>TradingView (ابزار رسم)</button>
        </div>
        {chartMode === "signal"
          ? <MarketChart candles={result.snapshot.candles} higher={result.snapshot.higherTimeframes["4h"]} interval={result.snapshot.interval} signal={result.signal} />
          : <TradingViewChart symbol={result.snapshot.symbol} interval={result.snapshot.interval} />}
        <div className="source-line"><Database size={14} /><span>{result.snapshot.exchange} · آخرین کندل {dateTime(result.snapshot.candles.at(-1)?.time)} · دریافت {age(result.snapshot.fetchedAt)}</span></div>
      </Panel>
      <Panel className="signal-panel" title="تصمیم موتور سیگنال"><SignalCard signal={result.signal} /></Panel>
      <Panel className="metrics-panel" title="وضعیت بازار">
        <div className="metric-grid three">
          <Metric label="روند اجرا" value={result.metrics.trend} /><Metric label="روند ۴ ساعته" value={result.metrics.higherTrend} /><Metric label="ساختار" value={result.metrics.structure} />
          <Metric label="RSI14" value={fmt(result.metrics.rsi14, 1)} /><Metric label="ADX14" value={fmt(result.metrics.adx14, 1)} /><Metric label="ATR" value={pct(result.metrics.atrPct)} />
          <Metric label="حجم / میانگین" value={fmt(result.metrics.volumeRatio)} /><Metric label="Funding" value={pct(result.snapshot.derivatives.fundingRate !== null ? result.snapshot.derivatives.fundingRate * 100 : null, 4)} /><Metric label="تغییر OI" value={pct(result.snapshot.derivatives.openInterestChangePct)} />
        </div>
      </Panel>
      <Panel className="council-panel" title="شورای اجباری" action={<Link className="text-link" to="/council">جزئیات <ArrowLeft size={14} /></Link>}>
        <div className="council-score"><strong>{fmt(result.reviews.filter((r) => r.verdict === "approve").length, 0)}</strong><span>از ۲۰ تأیید</span></div>
        <div className="vote-bar">{result.reviews.map((r) => <i key={r.role} className={r.verdict} title={`${r.role}: ${r.verdict}`} />)}</div>
        <ul className="compact-list">{result.reviews.filter((r) => r.verdict !== "approve").slice(0, 4).map((r) => <li key={r.role}><ShieldAlert size={15} /><span>{r.role}</span><small>{r.reasonsAgainst[0]}</small></li>)}</ul>
      </Panel>
      <Panel className="next-panel" title="مسیر اعتبارسنجی">
        <div className="workflow-steps">
          <div className="done"><CheckCircle2 /><span>اتصال و کنترل OHLCV</span></div>
          <div className={result.strategy.available ? "done" : ""}>{result.strategy.available ? <CheckCircle2 /> : <CircleDashed />}<span>بک‌تست خارج از نمونه</span></div>
          <div className={result.macro.available ? "done" : ""}>{result.macro.available ? <CheckCircle2 /> : <CircleDashed />}<span>پنجرهٔ اخبار و کلان</span></div>
          <div className={result.signal.status === "approved" ? "done" : ""}>{result.signal.status === "approved" ? <CheckCircle2 /> : <CircleDashed />}<span>تأیید هر ۲۰ نقش</span></div>
        </div>
        <Link to="/backtest" className="button secondary full"><FlaskConical size={17} /> اجرای بک‌تست دارایی</Link>
      </Panel>
    </div>}
  </>;
}
