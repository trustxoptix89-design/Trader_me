import { Activity, CheckCircle2, Database, ExternalLink, LogOut, Newspaper, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useMarket } from "@/providers/market";
import { EmptyState, ErrorState, LoadingState, PageTitle, Panel, StatusBadge } from "@/components/Common";
import { dateTime } from "@/lib/format";

export function NewsPage() {
  const news = trpc.trading.news.useQuery(), macro = trpc.trading.macro.useQuery();
  return <><PageTitle eyebrow="PUBLIC FEEDS / POINT-IN-TIME" title="اخبار و رویدادهای کلان" description="منبع، زمان انتشار و دریافت برای هر خبر ثبت می‌شود؛ ارتباط سببی خودکار فرض نمی‌شود." action={<button className="button secondary" onClick={() => { void news.refetch(); void macro.refetch(); }}><RefreshCw size={16} /> به‌روزرسانی</button>} />
    <Panel title="وضعیت فیلتر کلان">{macro.isLoading && <LoadingState />}{macro.data && <><StatusBadge tone={macro.data.available && macro.data.safe ? "good" : "warn"}>{macro.data.available && macro.data.safe ? "پنجرهٔ بررسی‌شده" : "داده ناکافی / توقف سیگنال"}</StatusBadge><ul className="check-list">{macro.data.details.map((d, i) => <li key={i} className={macro.data.safe ? "pass" : "fail"}><span>{d}</span></li>)}</ul></>}{macro.error && <ErrorState error={macro.error.message} />}</Panel>
    <Panel title="جریان خبری واقعی">{news.isLoading && <LoadingState label="دریافت RSS از منابع عمومی…" />}{news.error && <ErrorState error={news.error.message} />}{news.data?.errors.map((e) => <p className="warning-text" key={e}>{e}</p>)}<div className="news-list">{news.data?.items.map((item) => <article key={`${item.source}-${item.id}`} className="news-item"><div className="news-source"><Newspaper size={16} /><strong>{item.source}</strong><span>انتشار: {dateTime(item.publishedAt)}</span><span>دریافت: {dateTime(item.receivedAt)}</span></div><h3>{item.title}</h3><p>{item.confidenceLimit}</p>{item.assets.length > 0 && <div className="tag-row">{item.assets.map((a, i) => <span key={`${a}-${i}`}>{a}</span>)}</div>}{item.url && <a href={item.url} target="_blank" rel="noreferrer" className="text-link">مشاهده در منبع <ExternalLink size={14} /></a>}</article>)}</div>{news.data?.items.length === 0 && <EmptyState title="خبری دریافت نشد" detail="همهٔ منابع خبری در دسترس نیستند؛ این وضعیت فیلتر کلان را نامعتبر می‌کند." />}</Panel>
  </>;
}

const sourceDocs = [
  { name: "Yahoo Finance (منبع اصلی کندل)", data: "OHLCV شاخص تجمیعی اسپات (USD)؛ بازه ۱ دقیقه تا ۱ روز", limit: "بدون کلید؛ نرخ درخواست رسمی منتشر نشده و با کش کوتاه رعایت می‌شود", history: "۱ دقیقه: ۵ روز؛ ۱۵/۳۰ دقیقه: ۱ ماه؛ ۱ ساعت و ۴ ساعت: ۶ ماه؛ روزانه: ۲ سال", url: "https://finance.yahoo.com/quote/BTC-USD/", note: "فقط قیمت اسپات تجمیعی؛ Funding، Open Interest و قیمت قرارداد دائمی ندارد. حجم برخی کندل‌ها ناقص است و دروازهٔ کیفیت آن را بررسی می‌کند. ۳ دقیقه‌ای و ۴ ساعته از کندل‌های ۱ دقیقه/۱ ساعته ساخته می‌شود." },
  { name: "CoinGecko (تأیید مستقل قیمت)", data: "OHLC سی‌دقیقه‌ای بدون حجم", limit: "بدون کلید؛ سقف نرخ نسخهٔ عمومی محدود است", history: "۱ روز اخیر", url: "https://docs.coingecko.com/reference/coins-id-ohlc", note: "فقط برای مقایسهٔ قیمت بسته‌شدن با منبع اصلی؛ اگر اختلاف زیاد باشد سیگنال تأیید نمی‌شود." },
  { name: "BLS / RSS", data: "تقویم انتشار آماری و اخبار عمومی", limit: "بدون کلید؛ احتمال تغییر ساختار feed", history: "فقط اطلاعات زمان‌دار موجود در feed", url: "https://www.bls.gov/schedule/news_release/", note: "پوشش کلان کامل جهانی نیست؛ نقص تقویم باعث توقف سیگنال است." },
];

export function SourcesPage() {
  const health = trpc.trading.sourceHealth.useQuery();
  return <><PageTitle eyebrow="REPLACEABLE CONNECTORS" title="مدیریت منابع داده" description="وضعیت زنده، دامنه و محدودیت هر منبع؛ دسترسی از ایران با آزمون واقعی سنجیده می‌شود، نه حدس." action={<button className="button secondary" onClick={() => void health.refetch()} disabled={health.isFetching}><RefreshCw size={16} /> آزمون اتصال</button>} />
    <Panel title="نتیجهٔ آزمون واقعی">{health.isLoading && <LoadingState label="آزمون دریافت ۵۰ کندل BTCUSDT از هر صرافی…" />}<div className="source-health">{health.data?.map((h) => <div key={h.exchange}><div>{h.ok ? <CheckCircle2 className="positive" /> : <XCircle className="negative" />}<strong>{h.exchange}</strong></div><StatusBadge tone={h.ok ? "good" : "bad"}>{h.ok ? `پاسخ در ${h.latencyMs}ms` : "اختلال"}</StatusBadge><p>{h.detail}</p><small>{dateTime(h.checkedAt)}</small></div>)}</div></Panel>
    <div className="source-grid">{sourceDocs.map((s) => <Panel key={s.name} title={s.name}><dl className="source-spec"><div><dt>نوع داده</dt><dd>{s.data}</dd></div><div><dt>محدوده</dt><dd>{s.history}</dd></div><div><dt>دسترسی و نرخ</dt><dd>{s.limit}</dd></div><div><dt>خطا و محدودیت</dt><dd>{s.note}</dd></div></dl><a href={s.url} target="_blank" rel="noreferrer" className="text-link">مستندات رسمی <ExternalLink size={14} /></a></Panel>)}</div>
    <div className="warning-box"><ShieldCheck size={20} /><p>هیچ کلید API در فرانت‌اند ذخیره نمی‌شود. نسخهٔ اولیه فقط endpointهای عمومی و خواندنی استفاده می‌کند؛ قابلیت ارسال سفارش واقعی وجود ندارد.</p></div>
  </>;
}

export function SettingsPage() {
  const { user, isAuthenticated, logout } = useAuth(), market = useMarket(), config = trpc.trading.publicConfig.useQuery();
  return <><PageTitle eyebrow="PWA / SECURITY" title="تنظیمات" description="حساب، نصب اندروید و مرزهای امنیتی سامانه." />
    <div className="two-column"><Panel title="حساب کاربری">{isAuthenticated ? <div className="settings-user"><strong>{user?.name ?? "کاربر Kimi"}</strong><span>{user?.email ?? "ایمیل ثبت نشده"}</span><button className="button secondary" onClick={() => logout()}><LogOut size={16} /> خروج</button></div> : <><p>برای ذخیرهٔ تنظیمات، معاملات و هشدارها وارد شوید.</p><Link className="button primary inline" to="/login">ورود با Kimi</Link></>}</Panel>
      <Panel title="نصب روی اندروید"><ol className="assumption-list"><li>نسخهٔ منتشرشده را در Chrome اندروید باز کنید.</li><li>از منوی مرورگر «افزودن به صفحهٔ اصلی» یا Install app را انتخاب کنید.</li><li>برای Push پس‌زمینه، اجازهٔ Notification بدهید؛ بدون VAPID فقط هشدار داخل برنامه فعال است.</li></ol><StatusBadge tone={config.data?.pushConfigured ? "good" : "warn"}>{config.data?.pushConfigured ? "Push پیکربندی شده" : "Push نیازمند VAPID"}</StatusBadge></Panel></div>
    <Panel title="تنظیم پیش‌فرض تحلیل"><div className="inline-form"><label><span>دارایی</span><select value={market.symbol} onChange={(e) => market.setSymbol(e.target.value)}>{["BTCUSDT", "ETHUSDT", "SOLUSDT"].map((s) => <option key={s}>{s}</option>)}</select></label><label><span>منبع داده</span><output className="source-chip">Yahoo Finance · شاخص اسپات</output></label></div><p className="fine-print">تنظیم لحظه‌ای پنل است؛ حدود ریسک و فهرست پایش در پایگاه‌داده ذخیره می‌شوند.</p></Panel>
    <Panel title="مرز امنیتی"><div className="security-state"><ShieldCheck size={28} /><div><strong>معاملات واقعی: غیرفعال</strong><p>هیچ مسیر کد برای ارسال سفارش، ذخیرهٔ کلید صرافی یا برداشت وجود ندارد. فعال‌سازی آینده نیازمند درخواست صریح و تأیید جداگانه است.</p></div></div></Panel>
  </>;
}

export function HealthPage() {
  const health = trpc.trading.health.useQuery();
  return <><PageTitle eyebrow="OBSERVABILITY" title="سلامت سامانه" description="پایگاه‌داده، منابع، زمان‌بندی و رویدادهای واقعی سرور." action={<button className="button secondary" onClick={() => void health.refetch()}><Activity size={16} /> بررسی مجدد</button>} />
    {health.isLoading && <LoadingState />}{health.error && <ErrorState error={health.error.message} />}{health.data && <>
      <div className="metric-grid three"><div className="metric"><span>پایگاه‌داده</span><strong className={health.data.database ? "positive" : "negative"}>{health.data.database ? "متصل" : "اختلال"}</strong></div><div className="metric"><span>معاملهٔ واقعی</span><strong>غیرفعال</strong></div><div className="metric"><span>زمان سرور</span><strong>{dateTime(health.data.serverTime)}</strong></div></div>
      <Panel title="منابع داده">{health.data.sources.map((s) => <div className="health-row" key={s.exchange}><Database size={18} /><strong>{s.exchange}</strong><StatusBadge tone={s.ok ? "good" : "bad"}>{s.ok ? "سالم" : "اختلال"}</StatusBadge><span>{s.detail}</span></div>)}</Panel>
      <Panel title="زمان‌بندی"><p>{health.data.schedulerMode}</p>{health.data.scheduler ? <div className="metric-grid three"><div className="metric"><span>آخرین تلاش</span><strong>{dateTime(health.data.scheduler.lastRunAt)}</strong></div><div className="metric"><span>آخرین موفقیت</span><strong>{dateTime(health.data.scheduler.lastSuccessAt)}</strong></div><div className="metric"><span>آخرین خطا</span><strong>{health.data.scheduler.lastError ?? "بدون خطا"}</strong></div></div> : <EmptyState title="اجرای زمان‌بندی ثبت نشده" detail="پس از اولین اجرای سرور، وضعیت اینجا ثبت می‌شود. در میزبانی suspend-shونده باید cron خارجی محافظت‌شده تنظیم شود." />}</Panel>
      <Panel title="رویدادهای اخیر">{health.data.events.map((e) => <div className={`event-row ${e.level}`} key={e.id}><strong>{e.event}</strong><span>{e.detail}</span><small>{dateTime(e.createdAt)}</small></div>)}{health.data.events.length === 0 && <EmptyState title="رویدادی ثبت نشده" detail="اجرای زمان‌بندی و خطاهای سیستم در این بخش ظاهر می‌شوند." />}</Panel>
    </>}
  </>;
}
