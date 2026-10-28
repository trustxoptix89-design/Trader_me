import type { ReactNode } from "react";
import { AlertTriangle, ArrowLeft, DatabaseZap, LoaderCircle, LockKeyhole } from "lucide-react";
import { Link } from "react-router";

export function Panel({ title, action, children, className = "" }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>
    {(title || action) && <header className="panel-head"><h2>{title}</h2>{action}</header>}
    <div className="panel-body">{children}</div>
  </section>;
}

export function StatusBadge({ tone = "neutral", children, pulse = false }: { tone?: "good" | "bad" | "warn" | "info" | "neutral"; children: ReactNode; pulse?: boolean }) {
  return <span className={`status-badge ${tone}`}><i className={pulse ? "pulse" : ""} />{children}</span>;
}

export function Metric({ label, value, detail, tone = "" }: { label: string; value: ReactNode; detail?: string; tone?: string }) {
  return <div className="metric"><span>{label}</span><strong className={tone}>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

export function LoadingState({ label = "در حال دریافت و اعتبارسنجی داده…" }: { label?: string }) {
  return <div className="state-block" role="status"><LoaderCircle className="spin" size={22} /><div><strong>{label}</strong><p>هیچ مقدار جایگزین یا نمونه‌ای نمایش داده نمی‌شود.</p></div></div>;
}

export function ErrorState({ error, retry }: { error: string; retry?: () => void }) {
  return <div className="state-block error" role="alert"><AlertTriangle size={22} /><div><strong>عملیات انجام نشد</strong><p>{error}</p>{retry && <button className="text-button" onClick={retry}>تلاش مجدد <ArrowLeft size={15} /></button>}</div></div>;
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="state-block empty"><DatabaseZap size={22} /><div><strong>{title}</strong><p>{detail}</p>{action}</div></div>;
}

export function LoginRequired({ feature }: { feature: string }) {
  return <div className="state-block"><LockKeyhole size={22} /><div><strong>ورود برای {feature} لازم است</strong><p>داده‌های شخصی در پایگاه‌دادهٔ امن و جدا از سایر کاربران نگهداری می‌شوند.</p><Link className="button primary inline" to="/login">ورود با Kimi</Link></div></div>;
}

export function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}
