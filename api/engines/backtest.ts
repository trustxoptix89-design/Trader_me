import { createHash, randomUUID } from "node:crypto";
import type { BacktestMetrics, BacktestResult, BacktestTrade, Candle, Direction, Exchange, Interval, RiskSettings } from "@contracts/types";
import { emaSeries, rsiSeries, atrSeries } from "./indicators";

export interface BacktestParams { fast: number; slow: number; atrStop: number; rewardRisk: number; maxHoldingBars: number }
export const STRATEGY_VERSION = "ema-rsi-atr-v1.0.0";
/** Below this many out-of-sample trades no performance claim is supported. */
export const MIN_OOS_TRADES = 10;
/** A "robust" label needs at least this many out-of-sample trades; fewer is capped at "conditional". */
export const ROBUST_MIN_OOS_TRADES = 30;

export function classifyRobustness(oosTrades: number, oosNetPnl: number, allStable: boolean): BacktestResult["robustness"] {
  if (oosTrades < MIN_OOS_TRADES) return "unsupported";
  if (oosNetPnl > 0 && allStable && oosTrades >= ROBUST_MIN_OOS_TRADES) return "robust";
  return oosNetPnl > 0 ? "conditional" : "fragile";
}

/** Wilson score interval (95%) for a proportion, returned in percent. */
export function wilson95(successes: number, n: number): [number, number] | null {
  if (n <= 0) return null;
  const z = 1.959964, p = successes / n, z2 = z * z;
  const denom = 1 + z2 / n, centre = (p + z2 / (2 * n)) / denom;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
  return [Math.max(0, centre - half) * 100, Math.min(1, centre + half) * 100];
}

/** Unlevered long-only buy-and-hold from candles[startIndex].open to the last close, with the same costs. */
export function buyAndHold(candles: Candle[], startIndex: number, settings: RiskSettings) {
  const costRate = (settings.slippagePct + settings.spreadPct) / 100, feeRate = settings.feePct / 100;
  const entry = candles[startIndex].open * (1 + costRate), exit = candles.at(-1)!.close * (1 - costRate);
  const netReturnPct = (exit * (1 - feeRate) / (entry * (1 + feeRate)) - 1) * 100;
  let peak = entry, maxDd = 0;
  for (let i = startIndex; i < candles.length; i++) {
    maxDd = Math.max(maxDd, (peak - candles[i].low) / peak * 100);
    peak = Math.max(peak, candles[i].close);
  }
  return { startTime: candles[startIndex].time, endTime: candles.at(-1)!.time, netReturnPct, maxDrawdownPct: maxDd, note: "خرید و نگهداری بدون اهرم با کل سرمایه؛ با ریسک ثابت استراتژی هم‌اندازه نشده است." };
}

type SimTrade = BacktestTrade & { entryIndex: number };

interface Simulation {
  trades: BacktestTrade[];
  equityCurve: { time: number; equity: number; sample: "train" | "test" }[];
  metrics: BacktestMetrics;
  outOfSample: BacktestMetrics;
  maxDrawdownMtmPct: number;
}

function metricsFor(trades: BacktestTrade[], initialEquity: number): BacktestMetrics {
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  let equity = initialEquity, peak = initialEquity, maxDrawdownPct = 0, streak = 0, longest = 0;
  for (const trade of trades) {
    equity += trade.pnl; peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 100);
    streak = trade.pnl < 0 ? streak + 1 : 0; longest = Math.max(longest, streak);
  }
  const netPnl = trades.reduce((a, t) => a + t.pnl, 0);
  return {
    trades: trades.length, winRatePct: trades.length ? wins.length / trades.length * 100 : 0,
    expectancy: trades.length ? netPnl / trades.length : 0, profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownPct, averageWin: wins.length ? grossWin / wins.length : 0,
    averageLoss: losses.length ? -grossLoss / losses.length : 0, longestLossStreak: longest,
    netPnl, netReturnPct: initialEquity > 0 ? netPnl / initialEquity * 100 : 0,
    totalFees: trades.reduce((a, t) => a + t.fees, 0), totalFunding: trades.reduce((a, t) => a + t.funding, 0),
  };
}

function simulate(candles: Candle[], funding: { time: number; rate: number }[], settings: RiskSettings, p: BacktestParams, splitIndex: number): Simulation {
  const closes = candles.map((c) => c.close), fast = emaSeries(closes, p.fast), slow = emaSeries(closes, p.slow), rsi = rsiSeries(closes), atr = atrSeries(candles);
  const trades: BacktestTrade[] = [], curve: Simulation["equityCurve"] = [{ time: candles[0]?.time ?? 0, equity: settings.equity, sample: "train" }];
  let equity = settings.equity, i = Math.max(p.slow, 30), open: SimTrade | null = null;
  const costRate = (settings.slippagePct + settings.spreadPct) / 100;
  const feeRate = settings.feePct / 100;
  let mtmPeak = settings.equity, mtmMaxDd = 0;
  const markBar = (c: Candle, open: SimTrade | null, realized: number) => {
    const sign = open ? (open.side === "long" ? 1 : -1) : 0;
    const unreal = (price: number) => (open ? (price - open.entry) * open.quantity * sign - open.fees : 0);
    const adverse = open ? (sign === 1 ? c.low : c.high) : c.close;
    const trough = realized + unreal(adverse);
    if (mtmPeak > 0) mtmMaxDd = Math.max(mtmMaxDd, (mtmPeak - trough) / mtmPeak * 100);
    mtmPeak = Math.max(mtmPeak, realized + unreal(c.close));
  };
  const closeTrade = (trade: SimTrade, rawExit: number, time: number, reason: BacktestTrade["exitReason"]) => {
    const sign = trade.side === "long" ? 1 : -1;
    const exit = rawExit * (1 - sign * costRate);
    const gross = (exit - trade.entry) * trade.quantity * sign;
    const exitFee = exit * trade.quantity * feeRate;
    const fund = funding.filter((f) => f.time > trade.entryTime && f.time <= time).reduce((sum, f) => sum - sign * f.rate * trade.entry * trade.quantity, 0);
    trade.exit = exit; trade.exitTime = time; trade.exitReason = reason; trade.funding = fund;
    trade.fees += exitFee; trade.pnl = gross - trade.fees + fund;
    equity += trade.pnl; trades.push(trade); open = null;
    curve.push({ time, equity, sample: trade.sample });
  };
  for (; i < candles.length; i++) {
    const c = candles[i];
    if (open) {
      const sign = open.side === "long" ? 1 : -1;
      const stopHit = sign === 1 ? c.low <= open.stop : c.high >= open.stop;
      const targetHit = sign === 1 ? c.high >= open.target : c.low <= open.target;
      const adverse = sign === 1 ? c.low : c.high;
      const bankruptcy = open.entry * (1 - sign / Math.max(1, settings.maxLeverage));
      const liquidation = sign === 1 ? adverse <= bankruptcy : adverse >= bankruptcy;
      if (liquidation) closeTrade(open, bankruptcy, c.time, "liquidation");
      else if (stopHit) closeTrade(open, open.stop, c.time, "stop"); // conservative: stop first when both hit
      else if (targetHit) closeTrade(open, open.target, c.time, "target");
      else if (i - open.entryIndex >= p.maxHoldingBars) closeTrade(open, c.close, c.time, "time");
      markBar(c, open, equity);
    }
    if (!open && i + 1 < candles.length && fast[i] !== null && slow[i] !== null && rsi[i] !== null && atr[i] !== null) {
      let side: Direction | null = null;
      if (fast[i]! > slow[i]! && rsi[i]! > 52) side = "long";
      if (fast[i]! < slow[i]! && rsi[i]! < 48) side = "short";
      if (!side) continue;
      const next = candles[i + 1], sign = side === "long" ? 1 : -1;
      const entry = next.open * (1 + sign * costRate);
      const stop = entry - sign * atr[i]! * p.atrStop;
      const target = entry + sign * atr[i]! * p.atrStop * p.rewardRisk;
      if (stop <= 0 || target <= 0) continue;
      const riskAmount = equity * settings.riskPerTradePct / 100;
      const quantity = riskAmount / Math.abs(entry - stop);
      const notional = quantity * entry;
      if (equity <= 0 || notional / equity > settings.maxLeverage) continue;
      open = {
        side, signalTime: c.time, entryTime: next.time, exitTime: next.time, entry, exit: entry,
        stop, target, quantity, pnl: 0, fees: notional * feeRate, funding: 0, exitReason: "end",
        sample: i < splitIndex ? "train" : "test", entryIndex: i + 1,
      } as BacktestTrade & { entryIndex: number };
      i++; // entry is at this bar; evaluate exits from its range on next loop via explicit handling below
      const entryCandle = candles[i];
      const stopHit = sign === 1 ? entryCandle.low <= open.stop : entryCandle.high >= open.stop;
      const targetHit = sign === 1 ? entryCandle.high >= open.target : entryCandle.low <= open.target;
      if (stopHit) closeTrade(open, open.stop, entryCandle.time, "stop");
      else if (targetHit) closeTrade(open, open.target, entryCandle.time, "target");
      markBar(entryCandle, open, equity);
    }
  }
  if (open) closeTrade(open, candles.at(-1)!.close, candles.at(-1)!.time, "end");
  return { trades, equityCurve: curve, metrics: metricsFor(trades, settings.equity), outOfSample: metricsFor(trades.filter((t) => t.sample === "test"), settings.equity), maxDrawdownMtmPct: mtmMaxDd };
}

export function runBacktest(options: {
  candles: Candle[]; funding?: { time: number; rate: number }[]; settings: RiskSettings;
  params?: Partial<BacktestParams>; symbol: string; exchange: Exchange; interval: Interval;
}): BacktestResult {
  const candles = options.candles.filter((c) => c.closeTime <= Date.now()).sort((a, b) => a.time - b.time);
  if (candles.length < 300) throw new Error("برای جداسازی آموزش/آزمون و کنترل سوگیری حداقل ۳۰۰ کندل بسته لازم است");
  const p: BacktestParams = { fast: options.params?.fast ?? 20, slow: options.params?.slow ?? 50, atrStop: options.params?.atrStop ?? 1.5, rewardRisk: options.params?.rewardRisk ?? 2, maxHoldingBars: options.params?.maxHoldingBars ?? 48 };
  if (p.fast < 2 || p.slow <= p.fast || p.slow > 200 || p.atrStop <= 0 || p.rewardRisk < 1 || p.maxHoldingBars < 1) throw new Error("پارامترهای استراتژی نامعتبر است");
  const funding = options.funding ?? [];
  const splitIndex = Math.floor(candles.length * 0.7);
  const baseline = simulate(candles, funding, options.settings, p, splitIndex);
  const sensitivity: BacktestResult["sensitivity"] = [];
  for (const [parameter, values] of Object.entries({ fast: [Math.max(2, p.fast - 2), p.fast + 2], slow: [Math.max(p.fast + 2, p.slow - 5), p.slow + 5], atrStop: [Math.max(0.5, p.atrStop - 0.25), p.atrStop + 0.25] })) {
    for (const value of values) {
      const changed = { ...p, [parameter]: value };
      const run = simulate(candles, funding, options.settings, changed, splitIndex);
      sensitivity.push({ parameter, value, metrics: run.metrics });
    }
  }
  const walkForward: BacktestResult["walkForward"] = [];
  for (let fold = 0; fold < 3; fold++) {
    const evalStart = Math.floor(candles.length * (0.4 + fold * 0.2));
    const evalEnd = Math.floor(candles.length * (0.6 + fold * 0.2));
    const prefix = candles.slice(0, evalEnd);
    const run = simulate(prefix, funding, options.settings, p, splitIndex);
    const trades = run.trades.filter((t) => t.entryTime >= candles[evalStart].time && t.entryTime < candles[evalEnd - 1].time);
    walkForward.push({ fold: fold + 1, start: candles[evalStart].time, end: candles[evalEnd - 1].time, metrics: metricsFor(trades, options.settings.equity) });
  }
  const profitableSensitivity = sensitivity.filter((s) => s.metrics.netPnl > 0).length;
  const profitableFolds = walkForward.filter((w) => w.metrics.netPnl > 0).length;
  const robustness = classifyRobustness(baseline.outOfSample.trades, baseline.outOfSample.netPnl, profitableSensitivity === sensitivity.length && profitableFolds === 3);
  const oosWins = baseline.trades.filter((t) => t.sample === "test" && t.pnl > 0).length;
  const runId = randomUUID();
  return {
    runId, createdAt: Date.now(), symbol: options.symbol, exchange: options.exchange, interval: options.interval,
    strategyVersion: STRATEGY_VERSION, parameters: p,
    assumptions: [
      "سیگنال فقط با دادهٔ کندل بستهٔ t ساخته و ورود در Open کندل t+1 انجام می‌شود.",
      "کارمزد، لغزش و اسپرد بر اساس تنظیمات کاربر از هر دو سمت معامله کسر می‌شوند؛ لغزش و اسپرد بازسازی order book تاریخی نیستند.",
      "هم‌زمانی حد ضرر و هدف در یک کندل با قاعدهٔ محافظه‌کارانهٔ Stop-First حل می‌شود.",
      "Funding فقط از نقاط واقعی دریافت‌شده از همان صرافی محاسبه می‌شود؛ نبود تاریخ Funding صفر فرض نمی‌شود بلکه در پوشش داده گزارش می‌شود.",
      "لیکوییدیشن تقریبی با سقف اهرم و قیمت ورزشه است و جایگزین موتور دقیق مارجین صرافی نیست.",
      "maxDrawdownPct فقط از معاملات بسته‌شده محاسبه می‌شود؛ maxDrawdownMtmPct افت درون‌معامله‌ای را با بدترین قیمت هر کندل (Low برای خرید، High برای فروش) لحاظ می‌کند.",
      `برچسب «robust» حداقل ${ROBUST_MIN_OOS_TRADES} معامله در نمونهٔ آزمون می‌خواهد؛ کمتر از ${MIN_OOS_TRADES} معامله «unsupported» است و بین این دو حداکثر «conditional». بازهٔ اطمینان ۹۵٪ نرخ برد (Wilson) گزارش می‌شود.`,
      "اندازهٔ موقعیت با ریسک ثابت درصدی از Equity و بدون اهرم بالاتر از سقف محاسبه می‌شود.",
      "Walk-Forward با پارامتر ثابت و پنجره‌های ارزیابی پیش‌رو انجام شده؛ هیچ بهینه‌سازی روی دادهٔ آزمون انجام نشده است.",
    ],
    biasChecks: [
      { name: "Lookahead", passed: true, detail: "تأخیر یک کندل بین سیگنال و ورود اعمال شد" },
      { name: "Data leakage", passed: true, detail: "شاخصها فقط از پیشوند زمانی محاسبه و تقسیم ۷۰/۳۰ انجام شد" },
      { name: "Stale price", passed: candles.every((c, i) => i === 0 || c.time > candles[i - 1].time), detail: "ترتیب و یکتایی زمانی بررسی شد" },
      { name: "Survivorship", passed: true, detail: "یک قرارداد دائمی مشخص؛ مسئلهٔ حذف دارایی از Universe سهام وجود ندارد" },
      { name: "Execution feasibility", passed: true, detail: "هزینه، سقف اهرم و برخورد محافظه‌کارانهٔ SL/TP اعمال شد؛ عمق لحظه‌ای بازار محدودیت باقی‌مانده است" },
      { name: "Funding coverage", passed: funding.length > 0, detail: funding.length ? `${funding.length} نرخ واقعی Funding` : "تاریخ Funding دریافت نشد؛ نتیجه فاقد هزینهٔ Funding است" },
    ],
    metrics: { ...baseline.metrics, maxDrawdownMtmPct: baseline.maxDrawdownMtmPct }, outOfSample: baseline.outOfSample,
    outOfSampleWinRateCI95: wilson95(oosWins, baseline.outOfSample.trades),
    baselineBuyHold: buyAndHold(candles, Math.min(candles.length - 1, Math.max(p.slow, 30) + 1), options.settings), walkForward, sensitivity,
    equityCurve: baseline.equityCurve, trades: baseline.trades.map((t) => { const clean = { ...t } as Partial<SimTrade>; delete clean.entryIndex; return clean as BacktestTrade; }), robustness,
    data: { start: candles[0].time, end: candles.at(-1)!.time, candles: candles.length, fundingPoints: funding.length },
  };
}

export function backtestFingerprint(result: BacktestResult): string {
  return createHash("sha256").update(JSON.stringify({ p: result.parameters, d: result.data, v: result.strategyVersion })).digest("hex");
}
