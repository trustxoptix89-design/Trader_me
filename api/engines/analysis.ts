import { randomUUID } from "node:crypto";
import type { AnalysisResult, Direction, Exchange, Interval, RiskSettings } from "@contracts/types";
import { fetchSnapshotWithFallback, intervalToMs } from "../connectors/market";
import { computeMetrics } from "./indicators";
import { assessRisk } from "./risk";
import { runCouncil, type CouncilContext } from "./council";

export async function analyzeMarket(options: {
  exchange: Exchange; symbol: string; interval: Interval; riskSettings: RiskSettings;
  macro: CouncilContext["macro"]; strategy: CouncilContext["strategy"];
  dailyPnl?: number; currentEquity?: number; openRiskPct?: number; correlatedPositions?: number;
}): Promise<AnalysisResult> {
  const snapshot = await fetchSnapshotWithFallback(options.exchange, options.symbol, options.interval);
  const closed = snapshot.candles.filter((c) => c.closeTime <= snapshot.fetchedAt);
  if (closed.length >= 200) snapshot.candles = closed;
  const metrics = computeMetrics(snapshot);
  let direction: Direction | null = null;
  if (metrics.trend === "bullish" && metrics.higherTrend === "bullish") direction = "long";
  if (metrics.trend === "bearish" && metrics.higherTrend === "bearish") direction = "short";
  const riskDirection = direction ?? "long";
  const entry = snapshot.derivatives.markPrice ?? metrics.price;
  const atr = metrics.atr14 ?? entry * 0.01;
  const stop = riskDirection === "long" ? entry - atr * 1.5 : entry + atr * 1.5;
  const target = riskDirection === "long" ? entry + atr * 3 : entry - atr * 3;
  const risk = assessRisk(options.riskSettings, riskDirection, entry, stop, target, metrics, {
    dailyPnl: options.dailyPnl, currentEquity: options.currentEquity, openRiskPct: options.openRiskPct,
    correlatedPositions: options.correlatedPositions, dataComplete: snapshot.candles.length >= 200 && (snapshot.marketType === "spot-index" || snapshot.derivatives.fundingRate !== null),
    abnormalMarket: !snapshot.isFresh || snapshot.crossCheck?.status === "divergent",
  });
  const macro = options.macro;
  const strategy = snapshot.exchange === options.exchange ? options.strategy : { available: false, approved: false, details: ["منبع داده جایگزین فعال شده و بک‌تست منبع اولیه برای این بازار معتبر نیست"] };
  const reviews = runCouncil(snapshot, metrics, { direction, risk, macro, strategy, correlatedPositions: options.correlatedPositions, maxCorrelatedPositions: options.riskSettings.maxCorrelatedPositions });
  const allApproved = direction !== null && reviews.length === 20 && reviews.every((r, i) => r.verdict === "approve" || (snapshot.marketType === "spot-index" && r.verdict === "abstain" && i >= 11 && i <= 13)) && risk.approved && snapshot.isFresh && snapshot.crossCheck?.status !== "divergent";
  const issuedAt = Date.now();
  const version = reviews[0]?.analysisVersion ?? randomUUID();
  const failed = reviews.filter((r) => r.verdict === "reject");
  const signal = {
    id: randomUUID(), symbol: snapshot.symbol, exchange: snapshot.exchange, direction: allApproved ? direction : null,
    status: allApproved ? "approved" as const : "no-entry" as const,
    entryLow: direction ? entry - atr * 0.15 : null, entryHigh: direction ? entry + atr * 0.15 : null,
    activation: "تحلیل روی کندل بسته؛ فعال‌سازی فقط با عبور قیمت از نزدیک‌ترین سقف/کف کندل سیگنال و اعتبار مجدد داده",
    issuedAt, expiresAt: issuedAt + intervalToMs(options.interval) * 4,
    stopLoss: direction ? stop : null, targets: direction ? [target] : [], rewardRisk: direction ? 2 : null,
    positionSize: allApproved ? risk.positionSize : null,
    estimatedFunding: allApproved && risk.notional !== null && snapshot.derivatives.fundingRate !== null ? risk.notional * snapshot.derivatives.fundingRate : null,
    evidenceFor: reviews.filter((r) => r.verdict === "approve").flatMap((r) => r.reasonsFor).slice(0, 12),
    evidenceAgainst: failed.flatMap((r) => r.reasonsAgainst).slice(0, 20), risk,
    reasons: allApproved ? [snapshot.marketType === "spot-index" ? "تأیید ۱۷ نقش قابل‌اجرا، کنترل ریسک و اعتبار داده؛ ۳ بررسی مشتقات (Mark/Funding/OI) برای منبع اسپات اجرا نشد" : "تأیید هر ۲۰ نقش، کنترل ریسک و اعتبار داده"] : direction === null ? ["عدم هم‌راستایی روند تایم‌فریم‌ها؛ عدم ورود"] : failed.map((r) => `${r.role}: ${r.reasonsAgainst.join("؛")}`),
    analysisVersion: version,
  };
  return { snapshot, metrics, reviews, signal, macro, strategy };
}
