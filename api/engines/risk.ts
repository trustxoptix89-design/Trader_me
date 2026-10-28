import type { Direction, MarketMetrics, RiskAssessment, RiskSettings } from "@contracts/types";

export interface RiskContext {
  dailyPnl?: number;
  currentEquity?: number;
  openRiskPct?: number;
  correlatedPositions?: number;
  dataComplete?: boolean;
  abnormalMarket?: boolean;
}

export function assessRisk(
  settings: RiskSettings,
  direction: Direction,
  entry: number,
  stop: number,
  target: number,
  metrics: MarketMetrics,
  context: RiskContext = {},
): RiskAssessment {
  const reasons: string[] = [];
  const equity = context.currentEquity ?? settings.equity;
  const distance = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = distance > 0 ? reward / distance : 0;
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0 || stop <= 0 || distance <= 0) reasons.push("قیمت ورود یا حد ضرر معتبر نیست");
  if ((direction === "long" && (stop >= entry || target <= entry)) || (direction === "short" && (stop <= entry || target >= entry))) reasons.push("ترتیب ورود، حد ضرر و هدف با جهت معامله سازگار نیست");
  if (rr < 2) reasons.push("نسبت سود به زیان کمتر از حداقل ۲ است");
  if (context.dataComplete === false) reasons.push("داده برای تصمیم‌گیری کامل نیست");
  if (context.abnormalMarket || (metrics.atrPct !== null && metrics.atrPct > 10)) reasons.push("نوسان غیرعادی؛ صدور سیگنال متوقف شد");
  const dailyPnl = context.dailyPnl ?? 0;
  if (dailyPnl <= -equity * settings.maxDailyLossPct / 100) reasons.push("سقف زیان روزانه رسیده است");
  const drawdown = equity > 0 ? (settings.equity - equity) / settings.equity * 100 : 100;
  if (drawdown >= settings.maxDrawdownPct) reasons.push("سقف افت سرمایه رسیده است");
  if ((context.openRiskPct ?? 0) + settings.riskPerTradePct > settings.maxPortfolioRiskPct) reasons.push("ریسک تجمعی پرتفوی از سقف عبور می‌کند");
  if ((context.correlatedPositions ?? 0) >= settings.maxCorrelatedPositions) reasons.push("تعداد موقعیت‌های همبسته به سقف رسیده است");

  const riskAmount = equity * settings.riskPerTradePct / 100;
  const positionSize = distance > 0 ? riskAmount / distance : null;
  const notional = positionSize !== null ? positionSize * entry : null;
  const leverage = notional !== null && equity > 0 ? notional / equity : null;
  if (leverage !== null && leverage > settings.maxLeverage) reasons.push(`اهرم محاسبه‌شده (${leverage.toFixed(2)}) بیش از سقف مجاز است`);
  const estimatedFees = notional !== null ? notional * settings.feePct / 100 * 2 : null;
  if (estimatedFees !== null && estimatedFees >= riskAmount * 0.5) reasons.push("هزینهٔ تخمینی نسبت به ریسک معامله بیش از حد بالا است");

  return { approved: reasons.length === 0, reasons, positionSize, notional, riskAmount, leverage, estimatedFees };
}

export function calculatePosition(settings: RiskSettings, entry: number, stop: number): { quantity: number; notional: number; leverage: number; riskAmount: number } {
  if (entry <= 0 || stop <= 0 || entry === stop) throw new Error("ورود و حد ضرر باید مثبت و متفاوت باشند");
  const riskAmount = settings.equity * settings.riskPerTradePct / 100;
  const quantity = riskAmount / Math.abs(entry - stop);
  const notional = quantity * entry;
  return { quantity, notional, leverage: notional / settings.equity, riskAmount };
}
