import webpush from "web-push";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./queries/connection";
import { alerts, notifications, paperTrades, pushSubscriptions, schedulerState, systemEvents } from "@db/schema";
import { fetchDerivatives } from "./connectors/market";
import { macroAssessment } from "./connectors/news";
import { analyzeMarket } from "./engines/analysis";
import { getRisk, strategyContext, userRiskContext } from "./trading-router";
import { log } from "./lib/logger";

let running = false;
let timer: NodeJS.Timeout | null = null;

async function notify(userId: number, kind: string, title: string, body: string, dedupeKey: string, alertId?: number): Promise<boolean> {
  const db = getDb();
  const existing = await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.dedupeKey, dedupeKey)).limit(1);
  if (existing.length) return false;
  await db.insert(notifications).values({ userId, alertId, kind, title, body, dedupeKey }).onDuplicateKeyUpdate({ set: { dedupeKey } });
  const publicKey = process.env.VAPID_PUBLIC_KEY, privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return true;
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.invalid", publicKey, privateKey);
    const subscriptions = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    await Promise.allSettled(subscriptions.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys as { p256dh: string; auth: string } }, JSON.stringify({ title, body, url: "/alerts" }))));
  } catch (error) { log.warn("web push delivery failed", { error: error instanceof Error ? error.message : String(error) }); }
  return true;
}

export async function runScheduler(): Promise<{ ok: boolean; alertsChecked: number; notificationsCreated: number; error?: string }> {
  if (running) return { ok: true, alertsChecked: 0, notificationsCreated: 0 };
  running = true;
  const db = getDb();
  let checked = 0, created = 0;
  try {
    const activeAlerts = await db.select().from(alerts).where(eq(alerts.enabled, true));
    const macro = await macroAssessment().catch(() => ({ available: false, safe: false, details: ["سرویس اخبار/کلان در دسترس نیست"] }));
    for (const alert of activeAlerts) {
      checked++;
      try {
        const derivatives = await fetchDerivatives(alert.exchange, alert.symbol);
        const price = derivatives.markPrice;
        if (price === null || !Number.isFinite(price)) throw new Error("Mark Price نامعتبر است");
        let triggered = false, title = "", body = "";
        if (alert.kind === "price-above" && alert.threshold && price >= alert.threshold && (alert.lastValue === null || alert.lastValue < alert.threshold)) {
          triggered = true; title = `${alert.symbol} بالای آستانه`; body = `قیمت واقعی ${alert.exchange}: ${price}؛ آستانه: ${alert.threshold}`;
        }
        if (alert.kind === "price-below" && alert.threshold && price <= alert.threshold && (alert.lastValue === null || alert.lastValue > alert.threshold)) {
          triggered = true; title = `${alert.symbol} زیر آستانه`; body = `قیمت واقعی ${alert.exchange}: ${price}؛ آستانه: ${alert.threshold}`;
        }
        if (alert.kind === "signal" && Date.now() % 300_000 < 65_000) {
          const [risk, strategy] = await Promise.all([userRiskContext(alert.userId), strategyContext(alert.userId, alert.symbol, alert.exchange)]);
          const result = await analyzeMarket({ exchange: alert.exchange, symbol: alert.symbol, interval: "15m", riskSettings: risk.settings, macro, strategy, dailyPnl: risk.dailyPnl, openRiskPct: risk.openRiskPct, correlatedPositions: risk.correlatedPositions });
          if (result.signal.status === "approved") {
            triggered = true; title = `تأیید نهایی ${alert.symbol}`; body = `سیگنال ${result.signal.direction} با تأیید ۲۰ نقش؛ شناسه ${result.signal.id}`;
          }
        }
        if (triggered) {
          const dedupeKey = `${alert.id}:${alert.kind}:${Math.floor(Date.now() / 60_000)}`;
          if (await notify(alert.userId, alert.kind, title, body, dedupeKey, alert.id)) created++;
          await db.update(alerts).set({ lastTriggeredAt: new Date() }).where(eq(alerts.id, alert.id));
        }
        await db.update(alerts).set({ lastValue: price }).where(eq(alerts.id, alert.id));
      } catch (error) {
        if (alert.kind === "data-outage" && (!alert.lastTriggeredAt || Date.now() - alert.lastTriggeredAt.getTime() > 6 * 3_600_000)) {
          if (await notify(alert.userId, "data-outage", `اختلال دادهٔ ${alert.symbol}`, error instanceof Error ? error.message : String(error), `${alert.id}:outage:${Math.floor(Date.now() / (6 * 3_600_000))}`, alert.id)) created++;
          await db.update(alerts).set({ lastTriggeredAt: new Date() }).where(eq(alerts.id, alert.id));
        }
      }
    }
    const openTrades = await db.select().from(paperTrades).where(eq(paperTrades.status, "open"));
    for (const trade of openTrades) {
      try {
        const d = await fetchDerivatives(trade.exchange, trade.symbol), price = d.markPrice;
        if (!price) continue;
        const sign = trade.side === "long" ? 1 : -1;
        const reason = sign === 1 ? (price <= trade.stop ? "حد ضرر" : price >= trade.target ? "هدف" : "") : (price >= trade.stop ? "حد ضرر" : price <= trade.target ? "هدف" : "");
        if (reason) {
          const settings = await getRisk(trade.userId), exitFee = price * trade.quantity * settings.feePct / 100;
          const pnl = (price - trade.entry) * trade.quantity * sign - trade.fees - exitFee;
          await db.update(paperTrades).set({ status: "closed", exit: price, pnl, fees: trade.fees + exitFee, closedAt: new Date() }).where(and(eq(paperTrades.id, trade.id), eq(paperTrades.status, "open")));
          if (await notify(trade.userId, "paper-close", `بستن Paper Trade: ${reason}`, `${trade.symbol} در ${price} بسته شد؛ PnL بعد از کارمزد: ${pnl.toFixed(2)}`, `paper:${trade.id}:${reason}`)) created++;
        }
      } catch { /* a later scheduler run retries; stale price never closes a trade */ }
    }
    await db.insert(schedulerState).values({ id: "main", lastRunAt: new Date(), lastSuccessAt: new Date(), lastError: null, runCount: 1 }).onDuplicateKeyUpdate({ set: { lastRunAt: new Date(), lastSuccessAt: new Date(), lastError: null, runCount: sql`${schedulerState.runCount} + 1` } });
    await db.insert(systemEvents).values({ level: "info", event: "scheduler.success", detail: `${checked} alerts, ${created} notifications` });
    return { ok: true, alertsChecked: checked, notificationsCreated: created };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(schedulerState).values({ id: "main", lastRunAt: new Date(), lastError: message, runCount: 1 }).onDuplicateKeyUpdate({ set: { lastRunAt: new Date(), lastError: message, runCount: sql`${schedulerState.runCount} + 1` } }).catch(() => undefined);
    await db.insert(systemEvents).values({ level: "error", event: "scheduler.failure", detail: message }).catch(() => undefined);
    return { ok: false, alertsChecked: checked, notificationsCreated: created, error: message };
  } finally { running = false; }
}

export function startScheduler() {
  if (timer || process.env.DISABLE_SCHEDULER === "true") return;
  timer = setInterval(() => { void runScheduler().then((r) => { if (!r.ok) log.warn("scheduler run failed", { error: r.error }); }); }, 60_000);
  timer.unref();
  setTimeout(() => { void runScheduler(); }, 5_000).unref();
}
