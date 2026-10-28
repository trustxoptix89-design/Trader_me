import { useEffect, useState } from "react";
import { Bell, BellRing, Check, Plus, Trash2 } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useAuth } from "@/hooks/useAuth";
import { useMarket } from "@/providers/market";
import { EmptyState, ErrorState, LoginRequired, Metric, PageTitle, Panel, StatusBadge } from "@/components/Common";
import { dateTime, fmt, price } from "@/lib/format";
import { DEFAULT_RISK, type RiskSettings } from "@contracts/types";

export function RiskPage() {
  const { isAuthenticated } = useAuth(), utils = trpc.useUtils();
  const query = trpc.trading.riskGet.useQuery(undefined, { enabled: isAuthenticated });
  const [form, setForm] = useState<RiskSettings>(DEFAULT_RISK), [entry, setEntry] = useState("100000"), [stop, setStop] = useState("98000");
  useEffect(() => { if (query.data) setForm(query.data); }, [query.data]);
  const save = trpc.trading.riskUpdate.useMutation({ onSuccess: () => void utils.trading.riskGet.invalidate() });
  const size = trpc.trading.positionSize.useQuery({ settings: form, entry: Number(entry), stop: Number(stop) }, { enabled: Number(entry) > 0 && Number(stop) > 0 && Number(entry) !== Number(stop), retry: false });
  if (!isAuthenticated) return <><PageTitle eyebrow="CAPITAL PROTECTION" title="مدیریت ریسک" description="حدود محافظه‌کارانه و محاسبهٔ اندازهٔ موقعیت." /><LoginRequired feature="تنظیمات ریسک" /></>;
  const fields: { key: keyof RiskSettings; label: string; suffix: string }[] = [
    { key: "equity", label: "سرمایهٔ مبنا", suffix: "USD" }, { key: "riskPerTradePct", label: "ریسک هر معامله", suffix: "٪" },
    { key: "maxDailyLossPct", label: "سقف زیان روزانه", suffix: "٪" }, { key: "maxDrawdownPct", label: "سقف افت سرمایه", suffix: "٪" },
    { key: "maxLeverage", label: "سقف اهرم", suffix: "×" }, { key: "maxPortfolioRiskPct", label: "ریسک تجمعی", suffix: "٪" },
    { key: "maxCorrelatedPositions", label: "سقف موقعیت همبسته", suffix: "" }, { key: "feePct", label: "کارمزد هر سمت", suffix: "٪" },
    { key: "slippagePct", label: "لغزش فرضی", suffix: "٪" }, { key: "spreadPct", label: "اسپرد فرضی", suffix: "٪" },
  ];
  return <><PageTitle eyebrow="CAPITAL PROTECTION" title="مدیریت ریسک" description="پیش‌فرض محافظه‌کارانه: ریسک ۰٫۵٪، زیان روزانه ۲٪، افت ۱۰٪ و اهرم حداکثر ۳ برابر." />
    <div className="two-column wide-left"><Panel title="حدود عملیاتی"><form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(form); }}>{fields.map(({ key, label, suffix }) => <label key={key}><span>{label} {suffix}</span><input type="number" step="any" min="0" value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} required /></label>)}<button className="button primary" disabled={save.isPending}>ذخیرهٔ حدود ریسک</button></form>{save.data && <p className="success-text"><Check size={15} /> حدود جدید ذخیره و در تصمیم‌های بعدی اعمال شد.</p>}{save.error && <ErrorState error={save.error.message} />}</Panel>
      <Panel title="محاسبهٔ اندازهٔ موقعیت"><div className="inline-form vertical-mobile"><label><span>قیمت ورود</span><input type="number" step="any" value={entry} onChange={(e) => setEntry(e.target.value)} /></label><label><span>حد ضرر</span><input type="number" step="any" value={stop} onChange={(e) => setStop(e.target.value)} /></label></div>{size.data ? <div className="metric-grid two"><Metric label="مقدار" value={price(size.data.quantity)} /><Metric label="مبلغ اسمی" value={price(size.data.notional)} /><Metric label="اهرم" value={`${fmt(size.data.leverage)}×`} tone={size.data.leverage > form.maxLeverage ? "negative" : "positive"} /><Metric label="بودجهٔ ریسک" value={price(size.data.riskAmount)} /></div> : <EmptyState title="ورودی نامعتبر" detail="ورود و حد ضرر باید مثبت و متفاوت باشند." />}{size.data && size.data.leverage > form.maxLeverage && <p className="negative">این اندازه با سقف اهرم شما سازگار نیست و موتور ریسک آن را رد می‌کند.</p>}</Panel></div>
    <Panel title="قواعد توقف اجباری"><ul className="check-list"><li className="pass"><strong>نقص یا کهنگی داده</strong><span>عدم صدور سیگنال و عدم بستن Paper Trade با قیمت کهنه</span></li><li className="pass"><strong>ریسک تجمعی و همبستگی</strong><span>جمع ریسک موقعیت‌های باز و تعداد موقعیت‌های هم‌جهت کنترل می‌شود</span></li><li className="pass"><strong>شرایط غیرعادی</strong><span>ATR بیش از ۱۰٪ یا اختلال داده، ورود را متوقف و دلیل را ثبت می‌کند</span></li></ul></Panel>
  </>;
}

function base64ToUint8(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4), base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function AlertsPage() {
  const { isAuthenticated } = useAuth(), { exchange, symbol } = useMarket(), utils = trpc.useUtils();
  const list = trpc.trading.alertList.useQuery(undefined, { enabled: isAuthenticated }), notes = trpc.trading.notificationList.useQuery(undefined, { enabled: isAuthenticated });
  const config = trpc.trading.publicConfig.useQuery();
  const [kind, setKind] = useState<"price-above" | "price-below" | "signal" | "data-outage">("price-above"), [threshold, setThreshold] = useState(""), [message, setMessage] = useState("");
  const invalidate = () => { void utils.trading.alertList.invalidate(); void utils.trading.notificationList.invalidate(); };
  const add = trpc.trading.alertAdd.useMutation({ onSuccess: invalidate }), toggle = trpc.trading.alertToggle.useMutation({ onSuccess: invalidate }), del = trpc.trading.alertDelete.useMutation({ onSuccess: invalidate }), read = trpc.trading.notificationRead.useMutation({ onSuccess: invalidate });
  const subscribe = trpc.trading.pushSubscribe.useMutation();
  if (!isAuthenticated) return <><PageTitle eyebrow="ALERT ENGINE" title="مرکز هشدارها" description="ارزیابی سرور، جلوگیری از تکرار و اعلان PWA." /><LoginRequired feature="هشدارهای شخصی" /></>;
  const enableNotifications = async () => {
    setMessage("");
    try {
      if (!("Notification" in window)) { setMessage("این مرورگر از Notification پشتیبانی نمی‌کند؛ هشدارها همچنان در سرور و فهرست رویدادها ثبت می‌شوند."); return; }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setMessage("اجازهٔ اعلان در مرورگر داده نشد."); return; }
      if (!config.data?.vapidPublicKey) { setMessage("اجازهٔ اعلان ثبت شد؛ برای Push پس‌زمینه، کلیدهای VAPID باید روی سرور تنظیم شوند. هشدارهای سرور در فهرست رویدادها باقی می‌مانند."); return; }
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setMessage("این مرورگر Push پس‌زمینه را پشتیبانی نمی‌کند؛ هشدارهای سرور در فهرست رویدادها در دسترس‌اند."); return; }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToUint8(config.data.vapidPublicKey) });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("اشتراک Push معتبر نیست");
      await subscribe.mutateAsync({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      setMessage("اشتراک Push پس‌زمینه در سرور ثبت شد.");
    } catch (error) {
      setMessage(`فعال‌سازی اعلان انجام نشد: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return <><PageTitle eyebrow="ALERT ENGINE" title="مرکز هشدارها" description="ارزیابی در سرور هر ۶۰ ثانیه؛ بدون هشدار ده‌دقیقهٔ ساختگی و با کنترل تکرار." action={<button className="button secondary" onClick={() => void enableNotifications()}><BellRing size={17} /> فعال‌سازی اعلان</button>} />
    {message && <div className="info-box">{message}</div>}{config.data && !config.data.pushConfigured && <div className="warning-box"><Bell size={18} /><p>ارزیابی و ذخیرهٔ هشدار در سرور انجام می‌شود، اما ارسال Push پس‌زمینه تا تنظیم VAPID فعال نیست. این محدودیت پنهان نمی‌شود.</p></div>}
    <Panel title={`هشدار تازه برای ${symbol}`}><form className="inline-form" onSubmit={(e) => { e.preventDefault(); add.mutate({ exchange, symbol, kind, threshold: threshold ? Number(threshold) : undefined }); }}><label><span>نوع</span><select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="price-above">عبور قیمت به بالا</option><option value="price-below">عبور قیمت به پایین</option><option value="signal">تأیید نهایی سیگنال</option><option value="data-outage">اختلال دریافت داده</option></select></label>{(kind === "price-above" || kind === "price-below") && <label><span>آستانه</span><input type="number" step="any" min="0" value={threshold} onChange={(e) => setThreshold(e.target.value)} required /></label>}<button className="button primary" disabled={add.isPending}><Plus size={17} /> ایجاد هشدار</button></form>{add.error && <ErrorState error={add.error.message} />}</Panel>
    <div className="two-column wide-left"><Panel title="قوانین فعال">{list.data?.map((a) => <div className="alert-row" key={a.id}><div><strong>{a.symbol}</strong><span>{a.kind} {a.threshold ? `· ${price(a.threshold)}` : ""}</span></div><StatusBadge tone={a.enabled ? "good" : "neutral"}>{a.enabled ? "فعال" : "خاموش"}</StatusBadge><button className="text-button" onClick={() => toggle.mutate({ id: a.id, enabled: !a.enabled })}>{a.enabled ? "خاموش" : "فعال"}</button><button className="icon-button danger" aria-label="حذف هشدار" onClick={() => del.mutate({ id: a.id })}><Trash2 size={16} /></button></div>)}{list.data?.length === 0 && <EmptyState title="هشداری ساخته نشده" detail="یک قاعدهٔ قیمت، سیگنال یا اختلال داده بسازید." />}</Panel>
      <Panel title="رویدادهای دریافتی">{notes.data?.map((n) => <button className={`notification ${n.read ? "read" : ""}`} key={n.id} onClick={() => read.mutate({ id: n.id })}><strong>{n.title}</strong><p>{n.body}</p><span>{dateTime(n.createdAt)} · {n.read ? "خوانده‌شده" : "برای خوانده‌شدن کلیک کنید"}</span></button>)}{notes.data?.length === 0 && <EmptyState title="رویدادی وجود ندارد" detail="هشدارهای واقعی پس از فعال‌شدن در اینجا باقی می‌مانند." />}</Panel></div>
  </>;
}
