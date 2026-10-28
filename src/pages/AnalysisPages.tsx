import { Link } from "react-router";
import { AlertTriangle, ArrowLeft, Check, Minus, X } from "lucide-react";
import { useMarket } from "@/providers/market";
import { MarketControls } from "@/components/MarketControls";
import { MarketChart } from "@/components/MarketChart";
import { SignalCard } from "@/components/SignalCard";
import { EmptyState, ErrorState, LoadingState, Metric, PageTitle, Panel, StatusBadge } from "@/components/Common";
import { dateTime, fmt, pct, price } from "@/lib/format";

export function AssetAnalysisPage() {
  const { result, loading, error, refresh } = useMarket();
  return <><PageTitle eyebrow="MULTI-TIMEFRAME / DERIVATIVES" title="تحلیل دارایی" description="شواهد فنی، مشتقات و محدودیت‌های داده در یک نما." /><MarketControls />
    {loading && <LoadingState />}{error && <ErrorState error={error} retry={() => void refresh()} />}
    {!result && !loading && !error && <EmptyState title="داده‌ای برای تحلیل موجود نیست" detail="اتصال واقعی را اجرا کنید؛ تا دریافت پاسخ معتبر، نمودار و شاخص نمایش داده نمی‌شود." />}
    {result && <>
      <div className="two-column wide-left">
        <Panel title="کندل‌های منبع"><MarketChart candles={result.snapshot.candles} /><div className="source-line">منبع: {result.snapshot.exchange} · {result.snapshot.candles.length} کندل · آخرین زمان {dateTime(result.snapshot.candles.at(-1)?.time)}</div></Panel>
        <Panel title="مشتقات"><div className="metric-grid two"><Metric label="Mark Price" value={price(result.snapshot.derivatives.markPrice)} /><Metric label="Open Interest" value={price(result.snapshot.derivatives.openInterest)} /><Metric label="Funding" value={pct(result.snapshot.derivatives.fundingRate !== null ? result.snapshot.derivatives.fundingRate * 100 : null, 4)} /><Metric label="تغییر OI" value={pct(result.snapshot.derivatives.openInterestChangePct)} /></div><p className="fine-print">Funding و OI فقط مربوط به قرارداد {result.snapshot.symbol} در {result.snapshot.exchange} هستند و با بازار دیگر ترکیب نشده‌اند.</p></Panel>
      </div>
      <Panel title="ماتریس تحلیل"><div className="metric-grid four"><Metric label="EMA20" value={price(result.metrics.ema20)} /><Metric label="EMA50" value={price(result.metrics.ema50)} /><Metric label="EMA200" value={price(result.metrics.ema200)} /><Metric label="MACD Histogram" value={fmt(result.metrics.macdHistogram, 4)} /><Metric label="RSI14" value={fmt(result.metrics.rsi14)} /><Metric label="ADX14" value={fmt(result.metrics.adx14)} /><Metric label="نوسان تحقق‌یافته" value={pct(result.metrics.realizedVolatilityPct)} /><Metric label="گردش کندل USD" value={price(result.metrics.liquidityUsd)} /><Metric label="حمایت ۴۸ کندل" value={price(result.metrics.support)} /><Metric label="مقاومت ۴۸ کندل" value={price(result.metrics.resistance)} /><Metric label="حجم نسبی" value={fmt(result.metrics.volumeRatio)} /><Metric label="ساختار" value={result.metrics.structure} /></div></Panel>
      {result.snapshot.warnings.length > 0 && <div className="warning-box"><AlertTriangle size={19} /><div>{result.snapshot.warnings.map((w) => <p key={w}>{w}</p>)}</div></div>}
      <Panel title="تصمیم و فیلترها"><SignalCard signal={result.signal} /></Panel>
    </>}</>;
}

export function CouncilPage() {
  const { result, loading, error, refresh } = useMarket();
  return <><PageTitle eyebrow="10 OBSERVERS + 10 EXPERTS" title="شورای ۲۰ نقش تخصصی" description="هر رأی شامل روش، دادهٔ مصرفی، دلایل و محدودیت است؛ نقش‌ها ماژول‌های نرم‌افزاری مستقل‌وظیفه‌اند، نه ایجنت مستقل." action={<button className="button secondary" onClick={() => void refresh()} disabled={loading}>ارزیابی مجدد</button>} />
    {loading && <LoadingState />}{error && <ErrorState error={error} retry={() => void refresh()} />}
    {!result && !loading && !error && <EmptyState title="شورا هنوز تشکیل نشده" detail="ابتدا تحلیل واقعی یک دارایی را اجرا کنید." action={<Link className="button primary inline" to="/asset">رفتن به تحلیل <ArrowLeft size={16} /></Link>} />}
    {result && <><div className="council-summary"><Panel title="ناظران"><strong>{fmt(result.reviews.filter((r) => r.category === "observer" && r.verdict === "approve").length, 0)} / ۱۰</strong></Panel><Panel title="کارشناسان"><strong>{fmt(result.reviews.filter((r) => r.category === "expert" && r.verdict === "approve").length, 0)} / ۱۰</strong></Panel><Panel title="تصمیم نهایی"><StatusBadge tone={result.signal.status === "approved" ? "good" : "warn"}>{result.signal.status === "approved" ? "تأیید" : "عدم ورود"}</StatusBadge></Panel></div>
      <div className="review-list">{result.reviews.map((review, index) => <details key={review.role} className={`review ${review.verdict}`} open={index === 19}>
        <summary><span className="review-index">{fmt(index + 1, 0)}</span><span className="review-icon">{review.verdict === "approve" ? <Check /> : review.verdict === "reject" ? <X /> : <Minus />}</span><div><strong>{review.role}</strong><small>{review.category === "observer" ? "ناظر" : "کارشناس"} · {review.method}</small></div><StatusBadge tone={review.verdict === "approve" ? "good" : review.verdict === "reject" ? "bad" : "neutral"}>{review.verdict === "approve" ? "موافق" : review.verdict === "reject" ? "مخالف" : "ممتنع"}</StatusBadge></summary>
        <div className="review-body"><div><h4>داده‌های استفاده‌شده</h4><p>{review.dataUsed.join(" · ")}</p></div><div className="evidence-columns"><div><h4>دلایل موافق</h4>{review.reasonsFor.length ? <ul>{review.reasonsFor.map((r) => <li key={r}>{r}</li>)}</ul> : <p>—</p>}</div><div><h4>دلایل مخالف</h4>{review.reasonsAgainst.length ? <ul>{review.reasonsAgainst.map((r) => <li key={r}>{r}</li>)}</ul> : <p>—</p>}</div></div>{review.limitations.length > 0 && <div><h4>محدودیت ارزیابی</h4><p>{review.limitations.join("؛")}</p></div>}<p className="fine-print">زمان: {dateTime(review.reviewedAt)} · نسخهٔ تحلیل: {review.analysisVersion}</p></div>
      </details>)}</div></>}</>;
}
