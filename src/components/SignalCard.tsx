import { Link } from "react-router";
import { ArrowLeft, OctagonAlert, ShieldCheck } from "lucide-react";
import type { Signal } from "@contracts/types";
import { dateTime, faStatus, fmt, price } from "@/lib/format";
import { Metric, StatusBadge } from "./Common";

export function SignalCard({ signal }: { signal: Signal }) {
  const approved = signal.status === "approved";
  return <div className={`signal-card ${approved ? "approved" : "blocked"}`}>
    <div className="signal-head"><div><StatusBadge tone={approved ? "good" : "warn"} pulse={approved}>{faStatus(signal.status)}</StatusBadge><h3>{signal.symbol} <small>{signal.exchange}</small></h3></div>{approved ? <ShieldCheck size={28} /> : <OctagonAlert size={28} />}</div>
    <p className="signal-reason">{signal.reasons[0]}</p>
    <div className="metric-grid four">
      <Metric label="جهت" value={signal.direction ? faStatus(signal.direction) : "بدون ورود"} />
      <Metric label="محدودهٔ ورود" value={signal.entryLow ? `${price(signal.entryLow)} — ${price(signal.entryHigh)}` : "—"} />
      <Metric label="حد ضرر" value={price(signal.stopLoss)} />
      <Metric label="سود / زیان" value={signal.rewardRisk ? fmt(signal.rewardRisk) : "—"} />
    </div>
    <details className="evidence-details"><summary>شواهد موافق و مخالف <ArrowLeft size={15} /></summary>
      <div className="evidence-columns"><div><h4>موافق</h4>{signal.evidenceFor.length ? <ul>{signal.evidenceFor.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p>شواهد کافی برای تأیید وجود ندارد.</p>}</div><div><h4>مخالف / محدودیت</h4><ul>{signal.evidenceAgainst.map((x, i) => <li key={i}>{x}</li>)}</ul></div></div>
      <p className="fine-print">{signal.activation} · انقضا: {dateTime(signal.expiresAt)} · نسخه: {signal.analysisVersion}</p>
    </details>
    <Link to="/council" className="text-link">مشاهدهٔ رأی هر ۲۰ نقش <ArrowLeft size={15} /></Link>
  </div>;
}
