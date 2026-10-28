import { useState } from "react";
import { FlaskConical, ShieldCheck } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useMarket } from "@/providers/market";
import { EquityChart } from "@/components/MarketChart";
import { EmptyState, ErrorState, LoadingState, LoginRequired, Metric, PageTitle, Panel, StatusBadge } from "@/components/Common";
import { dateTime, faStatus, fmt, pct, price } from "@/lib/format";
import type { BacktestMetrics, BacktestResult, Exchange, Interval } from "@contracts/types";

function MetricsGrid({ metrics, title }: { metrics: BacktestMetrics; title: string }) {
  return <div className="result-metrics"><h3>{title}</h3><div className="metric-grid four"><Metric label="معاملات" value={fmt(metrics.trades, 0)} /><Metric label="وین‌ریت" value={pct(metrics.winRatePct)} /><Metric label="امید ریاضی" value={price(metrics.expectancy)} /><Metric label="Profit Factor" value={fmt(metrics.profitFactor)} /><Metric label="حداکثر افت" value={pct(metrics.maxDrawdownPct)} /><Metric label="میانگین برد" value={price(metrics.averageWin)} /><Metric label="میانگین باخت" value={price(metrics.averageLoss)} /><Metric label="زنجیرهٔ باخت" value={fmt(metrics.longestLossStreak, 0)} /><Metric label="PnL بعد از هزینه" value={price(metrics.netPnl)} tone={metrics.netPnl >= 0 ? "positive" : "negative"} /><Metric label="بازده" value={pct(metrics.netReturnPct)} /><Metric label="کارمزد" value={price(metrics.totalFees)} /><Metric label="Funding" value={price(metrics.totalFunding)} /></div></div>;
}

export function BacktestResultView({ result }: { result: BacktestResult }) {
  return <div className="backtest-result">
    <div className="result-banner"><div><span className="eyebrow">REPRODUCIBLE RUN</span><h2>{result.symbol} · {result.interval}</h2><p>{result.exchange} · {result.strategyVersion} · {dateTime(result.createdAt)}</p></div><StatusBadge tone={result.robustness === "robust" ? "good" : result.robustness === "conditional" ? "warn" : "bad"}>{faStatus(result.robustness)}</StatusBadge></div>
    <div className="warning-box"><ShieldCheck size={20} /><p>این نتیجه یک شبیه‌سازی فرضی و تخمین تحت فرض‌های ثبت‌شده است، نه پیش‌بینی یا وعدهٔ عملکرد. شناسه اجرا: <span dir="ltr">{result.runId}</span></p></div>
    <Panel title="منحنیٔ سرمایه"><EquityChart points={result.equityCurve} /><p className="fine-print">خط جداکننده، شروع بخش آزمون خارج از نمونه است. منحنی پس از بستن معاملات به‌روز می‌شود.</p></Panel>
    <Panel><MetricsGrid metrics={result.metrics} title="کل نمونه" /><MetricsGrid metrics={result.outOfSample} title="خارج از نمونه (۳۰٪ انتهایی)" /></Panel>
    <div className="two-column">
      <Panel title="Walk-Forward با پارامتر ثابت"><div className="table-wrap"><table><thead><tr><th>دوره</th><th>شروع</th><th>معامله</th><th>PnL</th><th>افت</th></tr></thead><tbody>{result.walkForward.map((w) => <tr key={w.fold}><td>{fmt(w.fold, 0)}</td><td>{dateTime(w.start)}</td><td>{fmt(w.metrics.trades, 0)}</td><td className={w.metrics.netPnl >= 0 ? "positive" : "negative"}>{price(w.metrics.netPnl)}</td><td>{pct(w.metrics.maxDrawdownPct)}</td></tr>)}</tbody></table></div></Panel>
      <Panel title="کنترل سوگیری"><ul className="check-list">{result.biasChecks.map((b) => <li key={b.name} className={b.passed ? "pass" : "fail"}><strong>{b.name}: {b.passed ? "عبور" : "ناموفق / محدودیت"}</strong><span>{b.detail}</span></li>)}</ul></Panel>
    </div>
    <Panel title="حساسیت پارامترها — همهٔ اجراها، نه فقط نتایج مطلوب"><div className="table-wrap"><table><thead><tr><th>پارامتر</th><th>مقدار</th><th>معامله</th><th>PF</th><th>PnL</th><th>افت</th></tr></thead><tbody>{result.sensitivity.map((s, i) => <tr key={`${s.parameter}-${i}`}><td>{s.parameter}</td><td>{fmt(s.value)}</td><td>{fmt(s.metrics.trades, 0)}</td><td>{fmt(s.metrics.profitFactor)}</td><td className={s.metrics.netPnl >= 0 ? "positive" : "negative"}>{price(s.metrics.netPnl)}</td><td>{pct(s.metrics.maxDrawdownPct)}</td></tr>)}</tbody></table></div></Panel>
    <Panel title="فرض‌های اجرا"><ol className="assumption-list">{result.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ol><p className="fine-print">داده: {fmt(result.data.candles, 0)} کندل از {dateTime(result.data.start)} تا {dateTime(result.data.end)} · نقاط Funding: {fmt(result.data.fundingPoints, 0)}</p></Panel>
    <Panel title={`معاملات ثبت‌شده (${fmt(result.trades.length, 0)})`}><div className="table-wrap"><table><thead><tr><th>ورود</th><th>جهت</th><th>قیمت</th><th>خروج</th><th>علت</th><th>PnL</th><th>نمونه</th></tr></thead><tbody>{result.trades.slice(-30).reverse().map((t, i) => <tr key={`${t.entryTime}-${i}`}><td>{dateTime(t.entryTime)}</td><td>{faStatus(t.side)}</td><td>{price(t.entry)}</td><td>{price(t.exit)}</td><td>{t.exitReason}</td><td className={t.pnl >= 0 ? "positive" : "negative"}>{price(t.pnl)}</td><td>{t.sample === "test" ? "آزمون" : "آموزش"}</td></tr>)}</tbody></table></div></Panel>
  </div>;
}

export function BacktestPage() {
  const { isAuthenticated } = useAuth(), { exchange, symbol, interval } = useMarket();
  const [params, setParams] = useState({ fast: 20, slow: 50, atrStop: 1.5, rewardRisk: 2, maxHoldingBars: 48, limit: 1000 });
  const [result, setResult] = useState<BacktestResult | null>(null);
  const mutation = trpc.trading.backtest.useMutation({ onSuccess: (data) => { setResult(data); void utils.trading.backtestList.invalidate(); } });
  const utils = trpc.useUtils();
  if (!isAuthenticated) return <><PageTitle eyebrow="RESEARCH LAB" title="آزمایشگاه بک‌تست" description="اجرای قابل تکرار با کنترل سوگیری و هزینه." /><LoginRequired feature="ذخیره و اجرای بک‌تست" /></>;
  return <><PageTitle eyebrow="RESEARCH LAB" title="آزمایشگاه بک‌تست" description={`${symbol} · ${exchange} · ${interval} · حداکثر ۱۰۰۰ کندل واقعی`} />
    <Panel title="پارامترهای از پیش ثبت‌شده"><form className="form-grid" onSubmit={(e) => { e.preventDefault(); setResult(null); mutation.mutate({ exchange: exchange as Exchange, symbol, interval: interval as Interval, ...params }); }}>
      {([["fast", "EMA سریع"], ["slow", "EMA کند"], ["atrStop", "ضریب ATR حد ضرر"], ["rewardRisk", "سود / زیان"], ["maxHoldingBars", "حداکثر نگهداری (کندل)"], ["limit", "تعداد کندل"]] as const).map(([key, label]) => <label key={key}><span>{label}</span><input type="number" min={key === "limit" ? 300 : 1} max={key === "limit" ? 1000 : undefined} step={key === "atrStop" ? .25 : 1} value={params[key]} onChange={(e) => setParams({ ...params, [key]: Number(e.target.value) })} required /></label>)}
      <button className="button primary" disabled={mutation.isPending} type="submit"><FlaskConical size={17} />{mutation.isPending ? "در حال شبیه‌سازی" : "اجرای بک‌تست واقعی"}</button>
    </form><p className="fine-print">پارامترها پیش از اجرا ثبت می‌شوند؛ موتور روی دادهٔ آزمون بهینه‌سازی نمی‌کند. تغییر صرافی/دارایی/تایم‌فریم از نوار بالای داشبورد انجام می‌شود.</p></Panel>
    {mutation.isPending && <LoadingState label="دریافت تاریخ، Funding و اجرای حساسیت…" />}{mutation.error && <ErrorState error={mutation.error.message} />}
    {result ? <BacktestResultView result={result} /> : !mutation.isPending && <EmptyState title="اجرایی انتخاب نشده" detail="پس از اجرا، تمام نتایج—including نتایج منفی حساسیت—در همین صفحه و در گزارش عملکرد ثبت می‌شود." />}
  </>;
}

export function PerformancePage() {
  const { isAuthenticated } = useAuth();
  const query = trpc.trading.backtestList.useQuery(undefined, { enabled: isAuthenticated });
  const [selected, setSelected] = useState<string | null>(null);
  if (!isAuthenticated) return <><PageTitle eyebrow="STRATEGY EVIDENCE" title="عملکرد استراتژی‌ها" description="تاریخچهٔ اجراهای ذخیره‌شده در پایگاه‌داده." /><LoginRequired feature="گزارش عملکرد" /></>;
  const result = query.data?.find((r) => r.runId === selected) ?? query.data?.[0];
  return <><PageTitle eyebrow="STRATEGY EVIDENCE" title="عملکرد استراتژی‌ها" description="همهٔ اجراها با نسخه، فرض‌ها و نتایج خارج از نمونه؛ بدون حذف اجرای ناموفق." />
    {query.isLoading && <LoadingState />}{query.error && <ErrorState error={query.error.message} />}
    {query.data && query.data.length > 0 && <div className="run-selector"><label><span>اجرای ثبت‌شده</span><select value={result?.runId ?? ""} onChange={(e) => setSelected(e.target.value)}>{query.data.map((r) => <option key={r.runId} value={r.runId}>{r.symbol} · {dateTime(r.createdAt)} · {faStatus(r.robustness)}</option>)}</select></label></div>}
    {result ? <BacktestResultView result={result} /> : query.data && <EmptyState title="بک‌تستی ثبت نشده" detail="از آزمایشگاه بک‌تست اولین اجرای واقعی را انجام دهید." />}
  </>;
}
