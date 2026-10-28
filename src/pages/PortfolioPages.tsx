import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { BookPlus, Plus, Trash2, X } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useMarket } from "@/providers/market";
import { EmptyState, ErrorState, LoadingState, LoginRequired, PageTitle, Panel, StatusBadge } from "@/components/Common";
import { SignalCard } from "@/components/SignalCard";
import { dateTime, faStatus, fmt, price } from "@/lib/format";
import type { Exchange } from "@contracts/types";

export function AssetsPage() {
  const { isAuthenticated } = useAuth(), market = useMarket(), navigate = useNavigate(), utils = trpc.useUtils();
  const query = trpc.trading.watchlist.useQuery(undefined, { enabled: isAuthenticated });
  const [symbol, setSymbol] = useState("BTCUSDT"), [exchange, setExchange] = useState<Exchange>("binance");
  const invalidate = () => void utils.trading.watchlist.invalidate();
  const add = trpc.trading.watchlistAdd.useMutation({ onSuccess: invalidate }), remove = trpc.trading.watchlistRemove.useMutation({ onSuccess: invalidate });
  if (!isAuthenticated) return <><PageTitle eyebrow="WATCHLIST" title="دارایی‌های تحت پایش" description="فهرست شخصی و پایدار برای پایش و هشدار." /><LoginRequired feature="فهرست پایش" /></>;
  return <><PageTitle eyebrow="WATCHLIST" title="دارایی‌های تحت پایش" description="هر دارایی با بازار و صرافی خودش ثبت می‌شود؛ قیمت‌ها بین صرافی‌ها معادل فرض نمی‌شوند." />
    <Panel title="افزودن دارایی"><form className="inline-form" onSubmit={(e) => { e.preventDefault(); add.mutate({ symbol, exchange }); }}><label><span>نماد</span><select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"].map((s) => <option key={s}>{s}</option>)}</select></label><label><span>بازار</span><select value={exchange} onChange={(e) => setExchange(e.target.value as Exchange)}><option value="binance">Binance Futures</option><option value="bybit">Bybit Linear</option></select></label><button className="button primary" disabled={add.isPending}><Plus size={17} /> افزودن</button></form>{add.error && <ErrorState error={add.error.message} />}</Panel>
    <Panel title="فهرست پایش">{query.isLoading && <LoadingState />}{query.error && <ErrorState error={query.error.message} />}<div className="asset-list">{query.data?.map((asset) => <div key={asset.id} className="asset-row"><div><strong>{asset.symbol}</strong><span>{asset.exchange} · Perpetual</span></div><StatusBadge tone={asset.enabled ? "good" : "neutral"}>{asset.enabled ? "فعال" : "غیرفعال"}</StatusBadge><button className="button secondary" onClick={() => { market.setSymbol(asset.symbol); market.setExchange(asset.exchange); navigate("/asset"); }}>تحلیل</button><button className="icon-button danger" aria-label={`حذف ${asset.symbol}`} onClick={() => remove.mutate({ id: asset.id })}><Trash2 size={17} /></button></div>)}</div>{query.data?.length === 0 && <EmptyState title="فهرست خالی است" detail="دارایی اول را با فرم بالا اضافه کنید." />}</Panel>
  </>;
}

export function SignalsPage() {
  const { result } = useMarket(), { isAuthenticated } = useAuth();
  const history = trpc.trading.analysisHistory.useQuery(undefined, { enabled: isAuthenticated });
  return <><PageTitle eyebrow="SIGNAL CENTER" title="مرکز سیگنال‌ها" description="فقط تأیید هم‌زمان ۲۰ نقش، ریسک و اعتبار داده می‌تواند سیگنال نهایی بسازد." />
    {result ? <Panel title="آخرین تصمیم اجراشده"><SignalCard signal={result.signal} /></Panel> : <EmptyState title="تصمیم جاری وجود ندارد" detail="از صفحهٔ تحلیل، موتور را روی دادهٔ واقعی اجرا کنید." action={<Link className="button primary inline" to="/asset">اجرای تحلیل</Link>} />}
    {isAuthenticated && <Panel title="تأییدهای نهایی ثبت‌شده">{history.data?.filter((h) => h.status === "approved").length ? history.data.filter((h) => h.status === "approved").map((h) => <div className="history-row" key={h.id}><strong>{h.symbol}</strong><span>{h.result.signal.direction}</span><span>{dateTime(h.createdAt)}</span></div>) : <EmptyState title="تأیید نهایی ثبت نشده" detail="این خالی‌بودن به‌معنی نبود فرصت تأییدشده است، نه خطا." />}</Panel>}
  </>;
}

export function HistoryPage() {
  const { isAuthenticated } = useAuth();
  const query = trpc.trading.analysisHistory.useQuery(undefined, { enabled: isAuthenticated });
  const [selected, setSelected] = useState<string | null>(null);
  if (!isAuthenticated) return <><PageTitle eyebrow="AUDIT TRAIL" title="تاریخچهٔ سیگنال‌ها" description="ردیابی تصمیم‌ها و دلایل رد." /><LoginRequired feature="تاریخچهٔ سیگنال" /></>;
  const current = query.data?.find((h) => h.id === selected);
  return <><PageTitle eyebrow="AUDIT TRAIL" title="تاریخچهٔ سیگنال‌ها" description="هر «عدم ورود» نیز با نسخهٔ تحلیل و شواهد نگهداری می‌شود." />
    {query.isLoading && <LoadingState />}{query.error && <ErrorState error={query.error.message} />}
    <Panel title="۵۰ تصمیم اخیر"><div className="table-wrap"><table><thead><tr><th>زمان</th><th>دارایی</th><th>بازار</th><th>وضعیت</th><th>نسخه</th><th></th></tr></thead><tbody>{query.data?.map((h) => <tr key={h.id}><td>{dateTime(h.createdAt)}</td><td>{h.symbol}</td><td>{h.exchange}</td><td><StatusBadge tone={h.status === "approved" ? "good" : "warn"}>{faStatus(h.status)}</StatusBadge></td><td dir="ltr">{h.result.signal.analysisVersion}</td><td><button className="text-button" onClick={() => setSelected(selected === h.id ? null : h.id)}>{selected === h.id ? "بستن" : "شواهد"}</button></td></tr>)}</tbody></table></div>{query.data?.length === 0 && <EmptyState title="تاریخچه خالی است" detail="پس از اجرای تحلیل در حساب کاربری، تصمیم‌ها اینجا ثبت می‌شوند." />}</Panel>
    {current && <Panel title="جزئیات تصمیم"><SignalCard signal={current.result.signal} /></Panel>}
  </>;
}

export function PaperPage() {
  const { isAuthenticated } = useAuth(), { exchange, symbol } = useMarket(), utils = trpc.useUtils();
  const query = trpc.trading.paperList.useQuery(undefined, { enabled: isAuthenticated });
  const [side, setSide] = useState<"long" | "short">("long");
  const invalidate = () => { void utils.trading.paperList.invalidate(); };
  const open = trpc.trading.paperOpen.useMutation({ onSuccess: invalidate }), close = trpc.trading.paperClose.useMutation({ onSuccess: invalidate });
  if (!isAuthenticated) return <><PageTitle eyebrow="SIMULATION / LIVE PRICES" title="Paper Trading" description="معاملهٔ آزمایشی با قیمت واقعی و کارمزد." /><LoginRequired feature="Paper Trading" /></>;
  const positions = query.data?.filter((t) => t.status === "open") ?? [], closed = query.data?.filter((t) => t.status === "closed") ?? [];
  const total = closed.reduce((a, t) => a + (t.pnl ?? 0), 0);
  return <><PageTitle eyebrow="SIMULATION / LIVE PRICES" title="Paper Trading" description="هیچ سفارشی به صرافی ارسال نمی‌شود؛ ورود و خروج با قیمت واقعی همان بازار انجام می‌شود." />
    <div className="metric-grid three"><div className="metric"><span>موقعیت باز</span><strong>{fmt(positions.length, 0)}</strong></div><div className="metric"><span>معاملات بسته</span><strong>{fmt(closed.length, 0)}</strong></div><div className="metric"><span>PnL تحقق‌یافته</span><strong className={total >= 0 ? "positive" : "negative"}>{price(total)}</strong></div></div>
    <Panel title={`موقعیت آزمایشی ${symbol}`}><form className="inline-form" onSubmit={(e) => { e.preventDefault(); open.mutate({ exchange, symbol, side }); }}><label><span>جهت</span><select value={side} onChange={(e) => setSide(e.target.value as "long" | "short")}><option value="long">Long</option><option value="short">Short</option></select></label><button className="button primary" disabled={open.isPending}>باز کردن با قیمت واقعی</button></form><p className="fine-print">حد ضرر و هدف از نوسان ۳۰ کندل و قاعدهٔ ۱٫۵ ATR تقریبی / R:R=2 ساخته می‌شوند؛ موتور ریسک می‌تواند ورود را رد کند.</p>{open.error && <ErrorState error={open.error.message} />}{open.data && <p className="success-text">موقعیت در {price(open.data.entry)} ثبت شد.</p>}</Panel>
    <Panel title="موقعیت‌ها">{query.isLoading && <LoadingState />}<div className="table-wrap"><table><thead><tr><th>دارایی</th><th>جهت</th><th>ورود</th><th>حد ضرر / هدف</th><th>وضعیت</th><th>PnL</th><th></th></tr></thead><tbody>{query.data?.map((t) => <tr key={t.id}><td>{t.symbol}<small>{t.exchange}</small></td><td>{faStatus(t.side)}</td><td>{price(t.entry)}</td><td>{price(t.stop)} / {price(t.target)}</td><td>{faStatus(t.status)}</td><td className={Number(t.pnl) >= 0 ? "positive" : "negative"}>{price(t.pnl)}</td><td>{t.status === "open" && <button className="text-button" disabled={close.isPending} onClick={() => close.mutate({ id: t.id })}><X size={14} /> بستن با قیمت زنده</button>}</td></tr>)}</tbody></table></div>{query.data?.length === 0 && <EmptyState title="موقعیتی وجود ندارد" detail="اولین Paper Trade را با کنترل ریسک باز کنید." />}{close.error && <ErrorState error={close.error.message} />}</Panel>
  </>;
}

export function JournalPage() {
  const { isAuthenticated } = useAuth(), utils = trpc.useUtils();
  const query = trpc.trading.journalList.useQuery(undefined, { enabled: isAuthenticated });
  const [form, setForm] = useState({ symbol: "BTCUSDT", side: "long" as "long" | "short", entry: "", exit: "", quantity: "", pnl: "", thesis: "", mistakes: "" });
  const add = trpc.trading.journalAdd.useMutation({ onSuccess: () => { void utils.trading.journalList.invalidate(); setForm({ ...form, thesis: "", mistakes: "", pnl: "" }); } });
  const del = trpc.trading.journalDelete.useMutation({ onSuccess: () => void utils.trading.journalList.invalidate() });
  if (!isAuthenticated) return <><PageTitle eyebrow="TRADING JOURNAL" title="دفتر معاملات" description="ثبت منطقه، نتیجه و خطاها." /><LoginRequired feature="دفتر معاملات" /></>;
  return <><PageTitle eyebrow="TRADING JOURNAL" title="دفتر معاملات" description="ثبت دستی معاملات، جدا از سیگنال‌های موتور و Paper Trading." />
    <Panel title="ثبت معامله"><form className="form-grid" onSubmit={(e) => { e.preventDefault(); add.mutate({ symbol: form.symbol, side: form.side, entry: Number(form.entry), exit: form.exit ? Number(form.exit) : undefined, quantity: Number(form.quantity), pnl: form.pnl ? Number(form.pnl) : undefined, thesis: form.thesis, mistakes: form.mistakes || undefined, tradedAt: new Date() }); }}>
      <label><span>نماد</span><input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} required /></label><label><span>جهت</span><select value={form.side} onChange={(e) => setForm({ ...form, side: e.target.value as "long" | "short" })}><option value="long">Long</option><option value="short">Short</option></select></label>
      <label><span>ورود</span><input type="number" step="any" value={form.entry} onChange={(e) => setForm({ ...form, entry: e.target.value })} required /></label><label><span>خروج (اختیاری)</span><input type="number" step="any" value={form.exit} onChange={(e) => setForm({ ...form, exit: e.target.value })} /></label><label><span>مقدار</span><input type="number" step="any" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required /></label><label><span>PnL (اختیاری)</span><input type="number" step="any" value={form.pnl} onChange={(e) => setForm({ ...form, pnl: e.target.value })} /></label>
      <label className="span-two"><span>منطقهٔ معامله</span><textarea value={form.thesis} onChange={(e) => setForm({ ...form, thesis: e.target.value })} minLength={3} required /></label><label className="span-two"><span>خطاها و نکات</span><textarea value={form.mistakes} onChange={(e) => setForm({ ...form, mistakes: e.target.value })} /></label><button className="button primary" disabled={add.isPending}><BookPlus size={17} /> ثبت در دفتر</button>
    </form>{add.error && <ErrorState error={add.error.message} />}</Panel>
    <Panel title="یادداشت‌های ثبت‌شده">{query.data?.map((j) => <article className="journal-entry" key={j.id}><header><strong>{j.symbol} · {faStatus(j.side)}</strong><span>{dateTime(j.tradedAt)}</span><button className="icon-button danger" aria-label="حذف یادداشت" onClick={() => del.mutate({ id: j.id })}><Trash2 size={16} /></button></header><p>{j.thesis}</p>{j.mistakes && <p className="muted">خطاها: {j.mistakes}</p>}<small>{price(j.entry)} → {price(j.exit)} · مقدار {price(j.quantity)} · PnL {price(j.pnl)}</small></article>)}{query.data?.length === 0 && <EmptyState title="دفتر خالی است" detail="اولین معامله و منطقهٔ آن را ثبت کنید." />}</Panel>
  </>;
}
