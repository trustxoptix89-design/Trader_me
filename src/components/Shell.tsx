import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Link, useLocation } from "react-router";
import { Activity, Bell, BookOpen, Bot, ChartCandlestick, ChartNoAxesCombined, ChevronLeft, Database, Download, FlaskConical, History, LayoutDashboard, List, LogOut, Menu, Newspaper, Radio, RefreshCw, Settings, ShieldCheck, Signal, Users, WalletCards, X } from "lucide-react";
import { useMarket } from "@/providers/market";
import { useAuth } from "@/hooks/useAuth";
import { StatusBadge } from "./Common";
import { age } from "@/lib/format";

export const navigation = [
  { to: "/", label: "داشبورد", icon: LayoutDashboard },
  { to: "/assets", label: "دارایی‌ها", icon: List },
  { to: "/asset", label: "تحلیل دارایی", icon: ChartCandlestick },
  { to: "/signals", label: "مرکز سیگنال", icon: Signal },
  { to: "/council", label: "شورای ۲۰ نقش", icon: Users },
  { to: "/backtest", label: "آزمایشگاه بک‌تست", icon: FlaskConical },
  { to: "/performance", label: "عملکرد استراتژی", icon: ChartNoAxesCombined },
  { to: "/paper", label: "Paper Trading", icon: WalletCards },
  { to: "/history", label: "تاریخچهٔ سیگنال", icon: History },
  { to: "/journal", label: "دفتر معاملات", icon: BookOpen },
  { to: "/alerts", label: "هشدارها", icon: Bell },
  { to: "/news", label: "اخبار و کلان", icon: Newspaper },
  { to: "/risk", label: "مدیریت ریسک", icon: ShieldCheck },
  { to: "/sources", label: "منابع داده", icon: Database },
  { to: "/settings", label: "تنظیمات", icon: Settings },
  { to: "/health", label: "سلامت سامانه", icon: Activity },
];

interface InstallPrompt extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

export function Shell({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState(false), [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const drawerRef = useRef<HTMLElement>(null), closeRef = useRef<HTMLButtonElement>(null), menuButtonRef = useRef<HTMLButtonElement>(null);
  const { result, loading, refresh, lastAttempt } = useMarket();
  const { user, logout } = useAuth();
  const location = useLocation();
  useEffect(() => { setMenu(false); window.scrollTo({ top: 0, behavior: "instant" }); }, [location.pathname]);
  useEffect(() => {
    const handler = (e: Event) => { e.preventDefault(); setInstallPrompt(e as InstallPrompt); };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
      if (e.key !== "Tab") return;
      const items = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []);
      if (!items.length) return;
      const first = items[0], last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = previousOverflow; menuButtonRef.current?.focus(); };
  }, [menu]);
  const nav = <nav className="main-nav" aria-label="ناوبری اصلی">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => isActive ? "active" : ""}><Icon size={18} /><span>{label}</span><ChevronLeft size={14} className="nav-arrow" /></NavLink>)}</nav>;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">رفتن به محتوای اصلی</a>
    <aside className="sidebar">
      <Link to="/" className="brand"><span className="radar-logo"><i /></span><span><b>مِهرَک</b><small>EVIDENCE FUTURES</small></span></Link>
      {nav}
      <div className="sidebar-foot"><ShieldCheck size={17} /><span>معاملهٔ واقعی غیرفعال است</span></div>
    </aside>
    {menu && <><button className="backdrop" aria-label="بستن منو" onClick={() => setMenu(false)} /><aside id="mobile-navigation" ref={drawerRef} className="mobile-drawer" role="dialog" aria-modal="true" aria-label="ناوبری موبایل"><div className="drawer-head"><span className="brand"><b>مِهرَک</b></span><button ref={closeRef} className="icon-button" aria-label="بستن" onClick={() => setMenu(false)}><X /></button></div>{nav}</aside></>}
    <div className="workspace">
      <header className="topbar">
        <button ref={menuButtonRef} className="icon-button menu-button" aria-label="باز کردن منو" aria-expanded={menu} aria-controls="mobile-navigation" onClick={() => setMenu(true)}><Menu size={21} /></button>
        <div className="system-state">
          {result ? <StatusBadge tone={result.snapshot.isFresh ? "good" : "bad"} pulse={result.snapshot.isFresh}>{result.snapshot.isFresh ? "دادهٔ تأییدشده" : "دادهٔ کهنه"}</StatusBadge> : <StatusBadge tone="neutral">بدون دادهٔ نمایشی</StatusBadge>}
          <span>{result ? `${result.snapshot.exchange} · ${age(result.snapshot.fetchedAt)}` : lastAttempt ? "آخرین تلاش اتصال انجام شد" : "آمادهٔ اتصال"}</span>
        </div>
        <div className="top-actions">
          {installPrompt && <button className="icon-button" title="نصب PWA" aria-label="نصب برنامه" onClick={async () => { await installPrompt.prompt(); setInstallPrompt(null); }}><Download size={19} /></button>}
          <button className="icon-button" title="به‌روزرسانی تحلیل" aria-label="به‌روزرسانی تحلیل" disabled={loading} onClick={() => void refresh()}><RefreshCw size={19} className={loading ? "spin" : ""} /></button>
          {user ? <button className="user-button" onClick={() => logout()} title="خروج"><span>{user.name ?? "کاربر"}</span><LogOut size={17} /></button> : <Link className="login-link" to="/login"><Bot size={17} /> ورود</Link>}
        </div>
      </header>
      <div className="evidence-strip"><Radio size={14} /><span>فقط دادهٔ دارای منبع و زمان · عدم صدور سیگنال با هر مخالفت حل‌نشده</span><span className="strip-version">ENGINE v1.0</span></div>
      <main id="main-content" className="content">{children}</main>
    </div>
    <nav className="bottom-nav" aria-label="ناوبری موبایل">{[navigation[0], navigation[2], navigation[5], navigation[10]].map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"}><Icon size={20} /><span>{label}</span></NavLink>)}<button aria-label="باز کردن منوی بیشتر" aria-expanded={menu} aria-controls="mobile-navigation" onClick={() => setMenu(true)}><Menu size={20} /><span>بیشتر</span></button></nav>
  </div>;
}
